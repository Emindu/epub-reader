// End-to-end tests against the in-memory store: real HTTP, fake auth.
//   npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createApp } from './server.mjs';
import { MemoryStore } from './store.mjs';
import { MemoryFiles } from './files.mjs';

let server, base;
const files = new MemoryFiles();
before(async () => {
  const handle = createApp({
    store: new MemoryStore(),
    files,
    verifyToken: async t => { if (!t.startsWith('dev:')) throw new Error('bad'); return t.slice(4); },
  });
  server = http.createServer(handle);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  files.base = base;
});
after(() => server.close());

const idFor = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex');
const hl = (cfi, updatedAt, extra = {}) => ({
  id: idFor('highlight', 'sha256:book', cfi), kind: 'highlight', book: 'sha256:book', updatedAt,
  data: { cfi, color: 'yellow', text: 'Call me Ishmael.', chapter: '1', createdAt: 1 }, ...extra,
});

async function call(method, path, { user = 'alice', body, origin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers.Authorization = `Bearer dev:${user}`;
  if (origin) headers.Origin = origin;
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, headers: res.headers, json: res.status === 204 ? null : await res.json() };
}

test('rejects requests without a valid token', async () => {
  assert.equal((await call('GET', '/v1/sync', { user: null })).status, 401);
  const res = await fetch(`${base}/v1/sync`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(res.status, 401);
});

test('push then pull round-trips, and the cursor only moves forward', async () => {
  const push = await call('POST', '/v1/sync', { user: 'rt', body: { items: [hl('/4/2', 100), hl('/4/6', 100)] } });
  assert.equal(push.status, 200);
  assert.deepEqual(push.json.results.map(r => r.status), ['ok', 'ok']);
  assert.equal(push.json.cursor, 2);

  const all = await call('GET', '/v1/sync?since=0', { user: 'rt' });
  assert.equal(all.json.items.length, 2);
  assert.equal(all.json.cursor, 2);
  assert.equal(all.json.more, false);

  const none = await call('GET', '/v1/sync?since=2', { user: 'rt' });
  assert.deepEqual(none.json.items, []);
  assert.equal(none.json.cursor, 2);
});

test('users never see each other\'s items', async () => {
  await call('POST', '/v1/sync', { user: 'u1', body: { items: [hl('/4/2', 100)] } });
  const other = await call('GET', '/v1/sync?since=0', { user: 'u2' });
  assert.deepEqual(other.json.items, []);
});

test('last write wins; an older or equal write comes back stale with the stored copy', async () => {
  await call('POST', '/v1/sync', { user: 'lww', body: { items: [hl('/4/2', 200)] } });
  const older = await call('POST', '/v1/sync', { user: 'lww', body: { items: [hl('/4/2', 150, { data: { cfi: '/4/2', color: 'blue' } })] } });
  assert.equal(older.json.results[0].status, 'stale');
  assert.equal(older.json.results[0].item.data.color, 'yellow');
  assert.equal(older.json.results[0].item.updatedAt, 200);

  const tie = await call('POST', '/v1/sync', { user: 'lww', body: { items: [hl('/4/2', 200)] } });
  assert.equal(tie.json.results[0].status, 'stale');

  const newer = await call('POST', '/v1/sync', { user: 'lww', body: { items: [hl('/4/2', 300, { data: { cfi: '/4/2', color: 'green' } })] } });
  assert.equal(newer.json.results[0].status, 'ok');
});

test('the key is stored and kept on deletes, so other devices can find the note', async () => {
  const item = { ...hl('/4/2', 100), key: '/4/2' };
  await call('POST', '/v1/sync', { user: 'key', body: { items: [item] } });
  await call('POST', '/v1/sync', { user: 'key', body: { items: [{ id: item.id, kind: 'highlight', book: item.book, key: '/4/2', updatedAt: 200, deleted: true }] } });
  const { json } = await call('GET', '/v1/sync?since=0', { user: 'key' });
  assert.equal(json.items[0].key, '/4/2');
  assert.equal(json.items[0].deleted, true);
});

test('a delete is stored as a marker and reaches other devices', async () => {
  await call('POST', '/v1/sync', { user: 'del', body: { items: [hl('/4/2', 100)] } });
  const { json: first } = await call('GET', '/v1/sync?since=0', { user: 'del' });

  const del = { id: idFor('highlight', 'sha256:book', '/4/2'), kind: 'highlight', book: 'sha256:book', updatedAt: 200, deleted: true };
  assert.equal((await call('POST', '/v1/sync', { user: 'del', body: { items: [del] } })).json.results[0].status, 'ok');

  const { json: next } = await call('GET', `/v1/sync?since=${first.cursor}`, { user: 'del' });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].deleted, true);
  assert.equal(next.items[0].data, null);
});

test('pull pages through large histories with `more`', async () => {
  // 600 distinct items in three pushes; the server returns at most 500 per pull.
  for (let n = 0; n < 3; n++) {
    const items = Array.from({ length: 200 }, (_, i) => hl(`/4/${n}/${i}`, 100));
    await call('POST', '/v1/sync', { user: 'big', body: { items } });
  }
  // Re-pushing an item supersedes its old copy, so it's pulled once, not twice.
  await call('POST', '/v1/sync', { user: 'big', body: { items: [hl('/4/0/0', 101)] } });

  let since = 0, seen = new Set(), pages = 0, more = true;
  while (more) {
    const { json } = await call('GET', `/v1/sync?since=${since}`, { user: 'big' });
    json.items.forEach(i => seen.add(i.id)); since = json.cursor; more = json.more; pages++;
  }
  assert.equal(seen.size, 600);
  assert.equal(pages, 2);
  assert.equal(since, 601);
});

test('items for one book: live ones only, and only that user\'s', async () => {
  const other = { ...hl('/4/9', 100), id: idFor('highlight', 'sha256:other', '/4/9'), book: 'sha256:other' };
  await call('POST', '/v1/sync', { user: 'fb', body: { items: [hl('/4/2', 100), hl('/4/4', 100), other] } });
  await call('POST', '/v1/sync', { user: 'fb', body: { items: [{ ...hl('/4/4', 200), deleted: true, data: undefined }] } });
  const { status, json } = await call('GET', '/v1/items?book=' + encodeURIComponent('sha256:book'), { user: 'fb' });
  assert.equal(status, 200);
  assert.deepEqual(json.items.map(i => i.data.cfi), ['/4/2']);
  assert.deepEqual((await call('GET', '/v1/items?book=sha256:book', { user: 'nobody' })).json.items, []);
  assert.equal((await call('GET', '/v1/items', { user: 'fb' })).status, 400);
});

test('validation rejects malformed items', async () => {
  const bad = [
    { items: 'nope' },
    { items: [{ ...hl('/4/2', 100), id: 'short' }] },
    { items: [{ ...hl('/4/2', 100), kind: 'settings' }] },
    { items: [{ ...hl('/4/2', 100), key: 'x'.repeat(1001) }] },
    { items: [{ ...hl('/4/2', 100), updatedAt: 'yesterday' }] },
    { items: [{ ...hl('/4/2', 100), data: undefined }] },
    { items: [hl('/4/2', 100), hl('/4/2', 101)] },
  ];
  for (const body of bad) {
    const { status } = await call('POST', '/v1/sync', { body });
    assert.equal(status, 400, JSON.stringify(body).slice(0, 80));
  }
  const tooMany = { items: Array.from({ length: 201 }, (_, i) => hl(`/x/${i}`, 1)) };
  assert.equal((await call('POST', '/v1/sync', { body: tooMany })).status, 413);
});

test('CORS: allowed origins get headers and preflight works; others get none', async () => {
  const pre = await fetch(`${base}/v1/sync`, { method: 'OPTIONS', headers: { Origin: 'tauri://localhost' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'tauri://localhost');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);

  const evil = await call('GET', '/health', { origin: 'https://evil.example' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('book files: upload once via a signed URL, download, and delete with the book', async () => {
  const book = 'sha256:file';
  const up = await call('POST', '/v1/files/upload', { user: 'f', body: { book, contentType: 'application/epub+zip' } });
  assert.equal(up.status, 200);
  assert.equal(up.json.exists, false);
  const put = await fetch(up.json.url, { method: 'PUT', headers: { 'Content-Type': up.json.contentType }, body: 'EPUB-BYTES' });
  assert.equal(put.status, 200);

  assert.equal((await call('POST', '/v1/files/upload', { user: 'f', body: { book } })).json.exists, true);
  assert.equal((await call('GET', '/v1/files/download?book=' + encodeURIComponent(book), { user: 'other' })).status, 404, 'per user');

  const down = await call('GET', '/v1/files/download?book=' + encodeURIComponent(book), { user: 'f' });
  assert.equal(await (await fetch(down.json.url)).text(), 'EPUB-BYTES');

  // Removing the book everywhere (a pushed delete of its `book` item) deletes the file.
  const id = idFor('book', '*', book);
  await call('POST', '/v1/sync', { user: 'f', body: { items: [{ id, kind: 'book', book: '*', key: book, updatedAt: 1, data: { title: 'T' } }] } });
  await call('POST', '/v1/sync', { user: 'f', body: { items: [{ id, kind: 'book', book: '*', key: book, updatedAt: 2, deleted: true }] } });
  assert.equal((await call('GET', '/v1/files/download?book=' + encodeURIComponent(book), { user: 'f' })).status, 404);
  assert.equal((await call('POST', '/v1/files/upload', { user: 'f', body: {} })).status, 400);
});

test('readtext: a device\'s chunked text log syncs to another device', async () => {
  const chunk = n => ({
    id: idFor('readtext', '*', `2026-11-26|devA|${n}`), kind: 'readtext', book: '*', key: `2026-11-26|devA|${n}`, updatedAt: 100,
    data: { books: { 'sha256:book': { title: 'Alpha', sections: [{ label: 'Ch1', parts: ['x'.repeat(20000)] }] } } },
  });
  const push = await call('POST', '/v1/sync', { user: 'rtext', body: { items: [chunk(0), chunk(1)] } });
  assert.deepEqual(push.json.results.map(r => r.status), ['ok', 'ok']);
  const pull = await call('GET', '/v1/sync?since=0', { user: 'rtext' });
  assert.deepEqual(pull.json.items.map(i => i.key).sort(), ['2026-11-26|devA|0', '2026-11-26|devA|1']);
  assert.equal(pull.json.items[0].data.books['sha256:book'].sections[0].parts[0].length, 20000);
  // an oversized chunk is refused rather than stored
  const big = { ...chunk(2), data: { books: { k: { title: 't', sections: [{ label: 'l', parts: ['y'.repeat(70000)] }] } } } };
  assert.equal((await call('POST', '/v1/sync', { user: 'rtext', body: { items: [big] } })).status, 413);
});

test('guards: only allowed accounts, and per-account item and storage limits', async () => {
  const small = new MemoryFiles();
  const app = http.createServer(createApp({
    store: new MemoryStore({ maxItems: 3 }), files: small,
    verifyToken: async t => t.slice(4),
    allowedUids: ['me'], maxUserBytes: 10,
  }));
  await new Promise(r => app.listen(0, r));
  const b = `http://127.0.0.1:${app.address().port}`;
  small.base = b;
  const req = (method, path, user, body) => fetch(b + path, {
    method, headers: { Authorization: `Bearer dev:${user}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
  try {
    assert.equal((await req('GET', '/v1/sync?since=0', 'stranger')).status, 403, 'not on the allowlist');
    assert.equal((await req('GET', '/v1/sync?since=0', 'me')).status, 200);

    const three = ['/1', '/2', '/3'].map(c => hl(c, 1));
    assert.equal((await req('POST', '/v1/sync', 'me', { items: three })).status, 200);
    assert.equal((await req('POST', '/v1/sync', 'me', { items: [hl('/4', 1)] })).status, 413, 'a 4th live item is over the limit');
    // Deleting one makes room again; editing an existing one never counts twice.
    assert.equal((await req('POST', '/v1/sync', 'me', { items: [{ ...hl('/1', 2), deleted: true, data: undefined }] })).status, 200);
    assert.equal((await req('POST', '/v1/sync', 'me', { items: [hl('/4', 1), hl('/2', 3)] })).status, 200);

    const up = await (await req('POST', '/v1/files/upload', 'me', { book: 'sha256:big' })).json();
    await fetch(up.url, { method: 'PUT', body: 'x'.repeat(20) });           // 20 bytes: over the 10-byte cap
    const full = await req('POST', '/v1/files/upload', 'me', { book: 'sha256:next' });
    assert.equal(full.status, 413);
    assert.match((await full.json()).error, /storage is full/i);
  } finally { app.close(); }
});
