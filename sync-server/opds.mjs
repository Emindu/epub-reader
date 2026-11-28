// An OPDS catalogue of the user's synced library, so KOReader (or any OPDS reader)
// can browse it and download books over Wi-Fi.
//
//   GET /opds/                      the catalogue (Atom, OPDS 1.2)
//   GET /opds/get/<id>/<name>       one book, streamed with a real file name
//   GET /opds/cover/<id>            the small cover image, if the library entry has one
//
// An e-reader can't sign in to Firebase, so it uses HTTP Basic auth: the user name is
// ignored and the password is a feed token the user asks the app for (POST /v1/feed).
//   - The token is 32 random bytes. Only its SHA-256 is stored, with an expiry.
//   - Creating a new token replaces the old one; the app can also revoke it.
//   - It travels in the Authorization header, never in a URL, so it stays out of request logs.
//   - Repeated bad attempts from one address (and a high overall rate) get 429.
//   - Files are streamed through this service rather than redirected to Cloud Storage, so the
//     e-reader's credentials are never forwarded to another host.
// OPDS_ALLOW_URL_TOKEN=1 additionally accepts /opds/<token>/... for readers that can't do Basic
// auth. It's off by default because that puts the secret in URLs and logs.
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { objectName } from './files.mjs';

const BOOK_LIMIT = 5000;
const TYPES = {
  epub: ['epub', 'application/epub+zip'],
  pdf: ['pdf', 'application/pdf'],
  txt: ['txt', 'text/plain'],
  md: ['md', 'text/markdown'],
};
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[a-f0-9]{64}$/;
export const FEED_USER = 'read';

export const hashToken = token => createHash('sha256').update(token).digest('hex');
export const newFeedToken = () => randomBytes(32).toString('base64url');

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A name safe on any file system, keeping letters from any language. */
export function fileStem(title) {
  const s = String(title || '').normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim();
  return s || 'book';
}

const typeOf = format => TYPES[format] || TYPES.epub;

/** Content-Disposition with a plain fallback name and the full UTF-8 one (RFC 6266). */
export const disposition = name =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''` +
  encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Counts failures per key inside a sliding window; blocked() says how long a key must wait. */
export class FailureLimiter {
  constructor({ maxFailures = 10, windowMs = 10 * 60_000, now = Date.now } = {}) {
    this.max = maxFailures; this.windowMs = windowMs; this.now = now; this.hits = new Map();
  }
  blocked(key) {
    const h = this.hits.get(key);
    if (!h) return 0;
    const wait = h.first + this.windowMs - this.now();
    if (wait <= 0) { this.hits.delete(key); return 0; }
    return h.n >= this.max ? wait : 0;
  }
  fail(key) {
    const t = this.now();
    if (this.hits.size > 5000) {
      for (const [k, h] of this.hits) if (t - h.first > this.windowMs) this.hits.delete(k);
      if (this.hits.size > 5000) this.hits.clear();
    }
    let h = this.hits.get(key);
    if (!h || t - h.first > this.windowMs) { h = { first: t, n: 0 }; this.hits.set(key, h); }
    h.n++;
  }
}

/** Cloud Run appends the caller's address to X-Forwarded-For; earlier entries can be forged, so take the last. */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || '?';
}

/** The password of an HTTP Basic Authorization header (the user name is ignored), or null. */
function basicPassword(req) {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = Buffer.from(m[1], 'base64').toString('utf8');
  const i = s.indexOf(':');
  return i < 0 ? s : s.slice(i + 1);
}

/** Origin the e-reader used to reach us (Cloud Run terminates TLS and says so in x-forwarded-proto). */
function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return `${proto}://${req.headers.host}`;
}

function entryXml(book, base) {
  const d = book.data || {};
  const [ext, mime] = typeOf(d.format);
  const name = `${fileStem(d.title)}.${ext}`;
  const updated = new Date(book.updatedAt || Date.now()).toISOString();
  const links = [
    `<link rel="http://opds-spec.org/acquisition" href="${esc(`${base}/get/${book.id}/${encodeURIComponent(name)}`)}" type="${mime}"/>`,
  ];
  if (typeof d.cover === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(d.cover)) {
    const cover = esc(`${base}/cover/${book.id}`);
    links.push(`<link rel="http://opds-spec.org/image" href="${cover}" type="image/jpeg"/>`,
      `<link rel="http://opds-spec.org/image/thumbnail" href="${cover}" type="image/jpeg"/>`);
  }
  if (d.sourceUrl && /^https?:\/\//.test(d.sourceUrl)) links.push(`<link rel="alternate" href="${esc(d.sourceUrl)}" type="text/html"/>`);
  const note = d.sourceUrl ? `Saved article — ${d.sourceUrl}` : ext.toUpperCase();
  return `<entry><title>${esc(d.title || 'Untitled')}</title><id>urn:read:book:${book.id}</id><updated>${updated}</updated>` +
    (d.author ? `<author><name>${esc(d.author)}</name></author>` : '') +
    `<dc:format>${mime}</dc:format><summary>${esc(note)}</summary>${links.join('')}</entry>`;
}

export function catalogXml(books, base) {
  const updated = new Date(books.reduce((m, b) => Math.max(m, b.updatedAt || 0), 0) || Date.now()).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">` +
    `<id>urn:read:library</id><title>My Read library</title><updated>${updated}</updated>` +
    `<author><name>Read</name></author>` +
    `<link rel="self" href="${esc(base + '/')}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>` +
    `<link rel="start" href="${esc(base + '/')}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>` +
    books.map(b => entryXml(b, base)).join('') + `</feed>`;
}

/**
 * @param {{ maxFailures?: number, windowMs?: number, globalFailures?: number, allowUrlToken?: boolean, now?: () => number }} [opts]
 * @returns a handler(req, res, url, { store, files, allowed }) that returns false for paths that aren't /opds
 */
export function createOpds({ maxFailures = 10, windowMs = 10 * 60_000, globalFailures = 300, allowUrlToken = false, now = Date.now } = {}) {
  const perIp = new FailureLimiter({ maxFailures, windowMs, now });
  const overall = new FailureLimiter({ maxFailures: globalFailures, windowMs: 60_000, now });

  return async function handleOpds(req, res, url, { store, files, allowed }) {
    if (url.pathname !== '/opds' && !url.pathname.startsWith('/opds/')) return false;
    const reply = (status, text, headers = {}) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(text);
      return true;
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'method not allowed');

    let rest = url.pathname.slice('/opds'.length).split('/').filter(Boolean);
    let token = null;
    let prefix = '/opds';
    if (allowUrlToken && rest.length && TOKEN_RE.test(rest[0])) { token = rest[0]; prefix += '/' + token; rest = rest.slice(1); }
    else token = basicPassword(req);

    const ip = clientIp(req);
    const wait = Math.max(perIp.blocked(ip), overall.blocked('*'));
    if (wait) return reply(429, 'Too many failed attempts. Try again later.', { 'Retry-After': String(Math.ceil(wait / 1000)) });
    // No credentials yet: the normal challenge, not a failure.
    if (token === null) return reply(401, 'Sign in with your e-reader link password.', { 'WWW-Authenticate': 'Basic realm="Read library", charset="UTF-8"' });

    // One answer for every kind of bad credential, so probing tells nothing.
    const deny = () => { perIp.fail(ip); overall.fail('*'); return reply(401, 'Invalid or expired e-reader link.', { 'WWW-Authenticate': 'Basic realm="Read library", charset="UTF-8"' }); };
    if (!TOKEN_RE.test(token)) return deny();
    const feed = await store.feedForToken(hashToken(token));
    if (!feed || !(feed.expiresAt > Date.now()) || (allowed && !allowed.has(feed.uid))) return deny();
    const uid = feed.uid;
    const base = `${originOf(req)}${prefix}`;

    const [action = '', id = ''] = rest;
    if (action === '') {
      const have = await files.names(uid);
      const books = (await store.listBooks(uid, BOOK_LIMIT)).filter(b => have.has(objectName(uid, b.key)));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/atom+xml;profile=opds-catalog;kind=acquisition;charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : catalogXml(books, base));
      return true;
    }

    if ((action === 'get' || action === 'cover') && ID_RE.test(id)) {
      const book = (await store.listBooks(uid, BOOK_LIMIT)).find(b => b.id === id);
      if (!book) return reply(404, 'not found');
      const d = book.data || {};
      if (action === 'cover') {
        const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(d.cover || '');
        if (!m) return reply(404, 'not found');
        res.statusCode = 200;
        res.setHeader('Content-Type', `image/${m[1]}`);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.end(Buffer.from(m[2], 'base64'));
        return true;
      }
      const [ext, mime] = typeOf(d.format);
      const found = await files.read(uid, book.key);
      if (!found) return reply(404, 'This book has not finished uploading from the app yet.');
      res.statusCode = 200;
      res.setHeader('Content-Type', mime);
      if (found.size !== undefined) res.setHeader('Content-Length', String(found.size));
      res.setHeader('Content-Disposition', disposition(`${fileStem(d.title)}.${ext}`));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method === 'HEAD') { found.stream.destroy(); res.end(); return true; }
      try { await pipeline(found.stream, res); }
      catch (err) { console.error('opds download failed', err); res.destroy(err); }
      return true;
    }
    return reply(404, 'not found');
  };
}
