// Book files, one per user and content key, in Cloud Storage. Apps never see the
// bucket: the service hands out short-lived signed URLs to PUT or GET one object.
//
//   exists(uid, key)              -> boolean
//   uploadUrl(uid, key, type)     -> signed PUT URL
//   downloadUrl(uid, key)         -> signed GET URL, or null when there is no file
//   remove(uid, key)              -> deletes the file (no error if missing)
//   usage(uid)                    -> total bytes stored for the user
import { createHash } from 'node:crypto';

const URL_TTL_MS = 15 * 60 * 1000;

/** Object name: the key itself can be a URL, so it is hashed into a path-safe name. */
export const objectName = (uid, key) => `users/${uid}/books/${createHash('sha256').update(key).digest('hex')}`;

export class GcsFiles {
  /** @param {import('@google-cloud/storage').Bucket} bucket */
  constructor(bucket) { this.bucket = bucket; }

  async exists(uid, key) {
    const [ok] = await this.bucket.file(objectName(uid, key)).exists();
    return ok;
  }

  async uploadUrl(uid, key, contentType) {
    const [url] = await this.bucket.file(objectName(uid, key)).getSignedUrl({
      version: 'v4', action: 'write', expires: Date.now() + URL_TTL_MS, contentType,
    });
    return url;
  }

  async downloadUrl(uid, key) {
    const file = this.bucket.file(objectName(uid, key));
    const [ok] = await file.exists();
    if (!ok) return null;
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + URL_TTL_MS });
    return url;
  }

  async remove(uid, key) {
    await this.bucket.file(objectName(uid, key)).delete({ ignoreNotFound: true });
  }

  async usage(uid) {
    const [files] = await this.bucket.getFiles({ prefix: `users/${uid}/books/` });
    return files.reduce((n, f) => n + Number(f.metadata.size || 0), 0);
  }
}

/** In-memory stand-in for tests and local runs: serves its own "signed" URLs. */
export class MemoryFiles {
  constructor() { this.files = new Map(); this.tokens = new Map(); this.base = ''; }

  token(name, action, contentType) {
    const t = Math.random().toString(36).slice(2);
    this.tokens.set(t, { name, action, contentType });
    return `${this.base}/_memfiles/${t}`;
  }

  async exists(uid, key) { return this.files.has(objectName(uid, key)); }
  async uploadUrl(uid, key, contentType) { return this.token(objectName(uid, key), 'write', contentType); }
  async downloadUrl(uid, key) {
    const name = objectName(uid, key);
    return this.files.has(name) ? this.token(name, 'read') : null;
  }
  async remove(uid, key) { this.files.delete(objectName(uid, key)); }
  async usage(uid) {
    let n = 0;
    for (const [name, f] of this.files) if (name.startsWith(`users/${uid}/`)) n += f.body.length;
    return n;
  }

  /** Handles /_memfiles/<token>; returns false for any other path. */
  async handle(req, res, url) {
    if (!url.pathname.startsWith('/_memfiles/')) return false;
    const grant = this.tokens.get(url.pathname.slice('/_memfiles/'.length));
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
    if (!grant) { res.statusCode = 403; res.end(); return true; }
    if (req.method === 'PUT' && grant.action === 'write') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      this.files.set(grant.name, { body: Buffer.concat(chunks), type: req.headers['content-type'] || '' });
      res.statusCode = 200; res.end(); return true;
    }
    if (req.method === 'GET' && grant.action === 'read') {
      const f = this.files.get(grant.name);
      if (!f) { res.statusCode = 404; res.end(); return true; }
      res.setHeader('Content-Type', f.type || 'application/octet-stream');
      res.end(f.body); return true;
    }
    res.statusCode = 405; res.end(); return true;
  }
}
