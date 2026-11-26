// Read sync service: stores each user's highlights, bookmarks (and later
// vocab, journal, progress) so every device sees the same notes.
//
//   GET  /health                      liveness probe
//   GET  /v1/sync?since=<cursor>       changes after the cursor  -> { items, cursor, more }
//   POST /v1/sync   { items: [...] }   upload changes            -> { cursor, results }
//
// Every /v1 request needs `Authorization: Bearer <Firebase ID token>`.
//
// Environment:
//   PORT              set by Cloud Run (default 8080)
//   ALLOWED_ORIGINS   comma-separated CORS origins (defaults cover the Tauri app and local dev)
//   SYNC_STORE=memory in-memory store + dev tokens ("dev:<uid>"), for local runs and tests only
//   GOOGLE_CLOUD_PROJECT / credentials: picked up automatically on Cloud Run

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { MemoryStore, FirestoreStore } from './store.mjs';

const MAX_BODY = 1024 * 1024;          // 1 MB per request
const MAX_ITEMS = 200;                 // per push; keeps a Firestore transaction well under 500 writes
const MAX_DATA = 16 * 1024;            // per item, serialised
const PULL_LIMIT = 500;
const KINDS = new Set(['highlight', 'bookmark']);
const ID_RE = /^[a-f0-9]{64}$/;        // client sends sha256(kind|book|key) so ids are path-safe

const DEFAULT_ORIGINS = [
  'tauri://localhost',                 // Tauri on macOS / iOS
  'http://tauri.localhost',            // Tauri on Windows
  'https://tauri.localhost',
  'http://localhost:1520',             // desktop `tauri dev`
  'http://localhost:5173',             // web `npm run dev`
  'http://localhost:8080',             // web `npm start`
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Reject anything that isn't a well-formed item, so the store only sees clean data. */
export function validateItems(body) {
  if (!body || !Array.isArray(body.items)) throw new HttpError(400, 'expected { items: [...] }');
  if (body.items.length > MAX_ITEMS) throw new HttpError(413, `at most ${MAX_ITEMS} items per request`);
  const seen = new Set();
  return body.items.map((raw, n) => {
    const where = `items[${n}]`;
    if (!raw || typeof raw !== 'object') throw new HttpError(400, `${where}: not an object`);
    const { id, kind, book, updatedAt, deleted, data } = raw;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, `${where}.id: expected 64 hex chars`);
    if (seen.has(id)) throw new HttpError(400, `${where}.id: duplicate in this request`);
    seen.add(id);
    if (!KINDS.has(kind)) throw new HttpError(400, `${where}.kind: unknown kind`);
    if (typeof book !== 'string' || !book || book.length > 600) throw new HttpError(400, `${where}.book: expected a content key`);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new HttpError(400, `${where}.updatedAt: expected ms timestamp`);
    if (deleted !== undefined && typeof deleted !== 'boolean') throw new HttpError(400, `${where}.deleted: expected boolean`);
    if (!deleted) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, `${where}.data: expected an object`);
      if (JSON.stringify(data).length > MAX_DATA) throw new HttpError(413, `${where}.data: larger than ${MAX_DATA} bytes`);
    }
    return { id, kind, book, updatedAt, deleted: deleted === true, data: deleted ? null : data };
  });
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid JSON'); }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * @param {{ store: { pull: Function, push: Function },
 *           verifyToken: (token: string) => Promise<string>,
 *           allowedOrigins?: string[] }} deps
 */
export function createApp({ store, verifyToken, allowedOrigins = DEFAULT_ORIGINS }) {
  const origins = new Set(allowedOrigins);

  return async function handle(req, res) {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      if (url.pathname !== '/v1/sync') throw new HttpError(404, 'not found');

      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) throw new HttpError(401, 'missing bearer token');
      let uid;
      try { uid = await verifyToken(token); }
      catch { throw new HttpError(401, 'invalid or expired token'); }

      if (req.method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0);
        if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'since: expected a non-negative integer');
        return send(res, 200, await store.pull(uid, since, PULL_LIMIT));
      }
      if (req.method === 'POST') {
        const items = validateItems(await readJson(req));
        return send(res, 200, await store.push(uid, items));
      }
      throw new HttpError(405, 'method not allowed');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'internal error' });
    }
  };
}

async function productionDeps() {
  if (process.env.SYNC_STORE === 'memory') {
    console.warn('SYNC_STORE=memory: data is lost on restart and "dev:<uid>" tokens are accepted. Never use this on Cloud Run.');
    return {
      store: new MemoryStore(),
      verifyToken: async token => {
        if (!token.startsWith('dev:') || token.length < 5) throw new Error('bad dev token');
        return token.slice(4);
      },
    };
  }
  const { initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = initializeApp();
  const auth = getAuth(app);
  return {
    store: new FirestoreStore(getFirestore(app)),
    verifyToken: async token => (await auth.verifyIdToken(token)).uid,
  };
}

// Started directly (`node server.mjs`), not imported by the tests.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const deps = await productionDeps();
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const handle = createApp({ ...deps, allowedOrigins: [...DEFAULT_ORIGINS, ...extra] });
  const port = Number(process.env.PORT) || 8080;
  http.createServer(handle).listen(port, () => console.log(`Read sync service on :${port}`));
}
