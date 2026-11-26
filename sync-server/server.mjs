// Read sync service: stores each user's highlights, bookmarks, vocabulary,
// reading progress and journal so every device sees the same notes.
//
//   GET  /health                      liveness probe
//   GET  /v1/sync?since=<cursor>       changes after the cursor  -> { items, cursor, more }
//   POST /v1/sync   { items: [...] }   upload changes            -> { cursor, results }
//   GET  /v1/items?book=<contentKey>   every live item for one book -> { items }
//   POST /v1/files/upload { book, contentType } -> { exists } or { exists: false, url }  (signed PUT)
//   GET  /v1/files/download?book=<key>          -> { url }  (signed GET), 404 if not stored
//   A pushed delete of a `book` item also deletes that book's stored file.
//
// Every /v1 request needs `Authorization: Bearer <Firebase ID token>`.
//
// Environment:
//   PORT              set by Cloud Run (default 8080)
//   ALLOWED_ORIGINS   comma-separated CORS origins (defaults cover the Tauri app and local dev)
//   SYNC_STORE=memory in-memory store + dev tokens ("dev:<uid>"), for local runs and tests only
//   BOOKS_BUCKET      Cloud Storage bucket for book files (default <project>-books)
//   ALLOWED_UIDS      comma-separated Firebase uids allowed to sync; empty = any signed-in account
//   MAX_USER_BYTES    book storage per account (default 5 GiB)
//   MAX_USER_ITEMS    live items per account (default 200000)
//   GOOGLE_CLOUD_PROJECT / credentials: picked up automatically on Cloud Run

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { MemoryStore, FirestoreStore, QuotaError } from './store.mjs';
import { MemoryFiles, GcsFiles } from './files.mjs';

const MAX_BODY = 4 * 1024 * 1024;      // 4 MB per request (the app also splits pushes by size)
const MAX_ITEMS = 200;                 // per push; keeps a Firestore transaction well under 500 writes
const MAX_DATA = 64 * 1024;            // per item, serialised (a busy journal day is the biggest)
const PULL_LIMIT = 500;
const BOOK_LIMIT = 5000;
const KINDS = new Set(['book', 'highlight', 'bookmark', 'vocab', 'progress', 'journal', 'reflection', 'readtext']);
const ID_RE = /^[a-f0-9]{64}$/;        // client sends sha256(kind|book|key) so ids are path-safe
const MAX_KEY = 1000;                  // the item's name within its book: cfi, word, day…

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
    const { id, kind, book, key = '', updatedAt, deleted, data } = raw;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, `${where}.id: expected 64 hex chars`);
    if (seen.has(id)) throw new HttpError(400, `${where}.id: duplicate in this request`);
    seen.add(id);
    if (!KINDS.has(kind)) throw new HttpError(400, `${where}.kind: unknown kind`);
    if (typeof book !== 'string' || !book || book.length > 600) throw new HttpError(400, `${where}.book: expected a content key`);
    if (typeof key !== 'string' || key.length > MAX_KEY) throw new HttpError(400, `${where}.key: expected a string up to ${MAX_KEY} chars`);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new HttpError(400, `${where}.updatedAt: expected ms timestamp`);
    if (deleted !== undefined && typeof deleted !== 'boolean') throw new HttpError(400, `${where}.deleted: expected boolean`);
    if (!deleted) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, `${where}.data: expected an object`);
      if (JSON.stringify(data).length > MAX_DATA) throw new HttpError(413, `${where}.data: larger than ${MAX_DATA} bytes`);
    }
    return { id, kind, book, key, updatedAt, deleted: deleted === true, data: deleted ? null : data };
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
 * @param {{ store: { pull: Function, push: Function, forBook: Function },
 *           files: MemoryFiles | GcsFiles,
 *           verifyToken: (token: string) => Promise<string>,
 *           allowedOrigins?: string[],
 *           allowedUids?: string[] | null,
 *           maxUserBytes?: number }} deps
 */
export function createApp({ store, files, verifyToken, allowedOrigins = DEFAULT_ORIGINS, allowedUids = null, maxUserBytes = 5 * 1024 ** 3 }) {
  const origins = new Set(allowedOrigins);
  const allowed = allowedUids?.length ? new Set(allowedUids) : null;

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
      if (files.handle && await files.handle(req, res, url)) return;
      const routes = ['/v1/sync', '/v1/items', '/v1/files/upload', '/v1/files/download'];
      if (!routes.includes(url.pathname)) throw new HttpError(404, 'not found');

      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) throw new HttpError(401, 'missing bearer token');
      let uid;
      try { uid = await verifyToken(token); }
      catch { throw new HttpError(401, 'invalid or expired token'); }
      if (allowed && !allowed.has(uid)) throw new HttpError(403, 'This account is not allowed to use sync');

      if (url.pathname === '/v1/files/upload') {
        if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
        const { book, contentType } = await readJson(req);
        if (typeof book !== 'string' || !book || book.length > 600) throw new HttpError(400, 'book: expected a content key');
        const type = typeof contentType === 'string' && contentType.length < 100 ? contentType : 'application/octet-stream';
        if (await files.exists(uid, book)) return send(res, 200, { exists: true });
        if (await files.usage(uid) >= maxUserBytes) {
          throw new HttpError(413, `Book storage is full (${Math.round(maxUserBytes / 1024 ** 3)} GB). Remove some books to sync new ones.`);
        }
        return send(res, 200, { exists: false, url: await files.uploadUrl(uid, book, type), contentType: type });
      }
      if (url.pathname === '/v1/files/download') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
        const book = url.searchParams.get('book') || '';
        if (!book || book.length > 600) throw new HttpError(400, 'book: expected a content key');
        const signed = await files.downloadUrl(uid, book);
        if (!signed) throw new HttpError(404, 'no stored file for this book');
        return send(res, 200, { url: signed });
      }
      if (url.pathname === '/v1/items') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
        const book = url.searchParams.get('book') || '';
        if (!book || book.length > 600) throw new HttpError(400, 'book: expected a content key');
        return send(res, 200, { items: await store.forBook(uid, book, BOOK_LIMIT) });
      }
      if (req.method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0);
        if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'since: expected a non-negative integer');
        return send(res, 200, await store.pull(uid, since, PULL_LIMIT));
      }
      if (req.method === 'POST') {
        const items = validateItems(await readJson(req));
        const result = await store.push(uid, items);
        // A book removed everywhere: its file goes too (its notes stay, for a re-import).
        const removed = items.filter((i, n) => i.kind === 'book' && i.deleted && result.results[n]?.status === 'ok');
        await Promise.all(removed.map(i => files.remove(uid, i.key).catch(err => console.error('file delete failed', err))));
        return send(res, 200, result);
      }
      throw new HttpError(405, 'method not allowed');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof QuotaError) return send(res, 413, { error: err.message });
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
      files: new MemoryFiles(),
      verifyToken: async token => {
        if (!token.startsWith('dev:') || token.length < 5) throw new Error('bad dev token');
        return token.slice(4);
      },
    };
  }
  const { initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getStorage } = await import('firebase-admin/storage');
  const app = initializeApp();
  const auth = getAuth(app);
  const project = process.env.GOOGLE_CLOUD_PROJECT || app.options.projectId || '';
  return {
    store: new FirestoreStore(getFirestore(app), { maxItems: Number(process.env.MAX_USER_ITEMS) || 200_000 }),
    files: new GcsFiles(getStorage(app).bucket(process.env.BOOKS_BUCKET || `${project}-books`)),
    verifyToken: async token => (await auth.verifyIdToken(token)).uid,
  };
}

// Started directly (`node server.mjs`), not imported by the tests.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const deps = await productionDeps();
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const list = name => (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
  const handle = createApp({
    ...deps,
    allowedOrigins: [...DEFAULT_ORIGINS, ...extra],
    allowedUids: list('ALLOWED_UIDS'),
    maxUserBytes: Number(process.env.MAX_USER_BYTES) || 5 * 1024 ** 3,
  });
  const port = Number(process.env.PORT) || 8080;
  if (deps.files instanceof MemoryFiles) deps.files.base = `http://localhost:${port}`;
  http.createServer(handle).listen(port, () => console.log(`Read sync service on :${port}`));
}
