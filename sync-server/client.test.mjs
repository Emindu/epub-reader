// The app's sync module (src/sync.ts) driving simulated devices through this
// server with an in-memory store. Node runs the .ts file directly (type stripping,
// Node >= 23.6). Firebase sign-in is faked: tokens are "dev:<uid>".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './server.mjs';
import { MemoryStore } from './store.mjs';
import { Sync, GLOBAL } from '../src/sync.ts';

class LS { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
globalThis.window = { setTimeout, clearTimeout, setInterval: () => 0, addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };

let server, base;
before(async () => {
  server = http.createServer(createApp({ store: new MemoryStore(), verifyToken: async t => { if (!t.startsWith('dev:')) throw new Error('bad'); return t.slice(4); } }));
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('identitytoolkit')) {
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify({ localId: 'u-' + body.email, email: body.email, idToken: 'dev:u-' + body.email, refreshToken: 'r', expiresIn: '3600' }));
    }
    return realFetch(url, opts);
  };
});
after(() => server.close());

const tick = () => new Promise(r => setTimeout(r, 3));
const name = (kind, book, key) => `${kind}|${book}|${key}`;

/** A device whose storage is one map of items; journal entries for its own device id are ignored on apply, like the app. */
function device(label, books) {
  const ls = new LS();
  const d = { label, ls, books, items: new Map(), applied: 0 };
  globalThis.localStorage = ls;
  d.sync = new Sync({ serviceUrl: base, apiKey: 'k' }, {
    books: () => d.books,
    items: () => [...d.items.entries()]
      .map(([n, data]) => { const [kind, book, ...rest] = n.split('|'); return { kind, book, key: rest.join('|'), data: structuredClone(data) }; })
      .filter(i => i.book === GLOBAL || d.books.includes(i.book)),
    apply: changes => {
      d.applied++;
      for (const c of changes) {
        if (c.kind === 'journal' && c.key.endsWith(`|${d.sync.deviceId}`)) continue;
        if (c.data) d.items.set(name(c.kind, c.book, c.key), structuredClone(c.data)); else d.items.delete(name(c.kind, c.book, c.key));
      }
    },
    onStatus() {},
  });
  d.run = async fn => { globalThis.localStorage = ls; const r = await fn(d.sync); assert.equal(d.sync.status().lastError, '', `${label}: ${d.sync.status().lastError}`); return r; };
  d.set = (kind, book, key, data) => d.items.set(name(kind, book, key), data);
  d.get = (kind, book, key) => d.items.get(name(kind, book, key));
  d.del = (kind, book, key) => d.items.delete(name(kind, book, key));
  d.keys = (kind, book) => [...d.items.keys()].filter(n => n.startsWith(`${kind}|${book}|`)).map(n => n.split('|').slice(2).join('|')).sort();
  return d;
}

test('highlights and vocab: adds, edits, deletes, book removal, late import, conflicts', async () => {
  const A = 'sha256:A';
  const mac = device('mac', [A]);
  const phone = device('phone', [A]);
  mac.set('highlight', A, '/4/2', { cfi: '/4/2', color: 'yellow' });
  mac.set('highlight', A, '/4/4', { cfi: '/4/4', color: 'yellow' });
  mac.set('vocab', A, 'ephemeral', { word: 'ephemeral', ease: 2.5, dueAt: 1 });
  await mac.run(s => s.signIn('one@x.com', 'pw', true));

  phone.set('highlight', A, '/4/8', { cfi: '/4/8', color: 'pink' });   // phone had its own note before signing in
  await phone.run(s => s.signIn('one@x.com', 'pw', false));
  assert.deepEqual(phone.keys('highlight', A), ['/4/2', '/4/4', '/4/8']);
  assert.deepEqual(phone.get('vocab', A, 'ephemeral'), { word: 'ephemeral', ease: 2.5, dueAt: 1 });
  await mac.run(s => s.syncNow());
  assert.deepEqual(mac.keys('highlight', A), ['/4/2', '/4/4', '/4/8']);

  const quiet = mac.applied;
  await mac.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.equal(mac.applied, quiet, 'no apply when nothing changed (own pushes are not echoed back)');

  // Phone reviews the card, recolours one note and deletes another.
  await tick();
  phone.set('vocab', A, 'ephemeral', { word: 'ephemeral', ease: 2.6, dueAt: 99 });
  phone.set('highlight', A, '/4/2', { cfi: '/4/2', color: 'green' });
  phone.del('highlight', A, '/4/4');
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.deepEqual(mac.keys('highlight', A), ['/4/2', '/4/8']);
  assert.equal(mac.get('highlight', A, '/4/2').color, 'green');
  assert.equal(mac.get('vocab', A, 'ephemeral').dueAt, 99);

  // Removing the book on the phone must not delete anything elsewhere…
  phone.books = []; for (const k of [...phone.items.keys()]) if (k.includes(`|${A}|`)) phone.items.delete(k);
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.deepEqual(mac.keys('highlight', A), ['/4/2', '/4/8']);
  // …and re-importing it brings everything back.
  phone.books = [A];
  await phone.run(s => s.syncNow());
  assert.deepEqual(phone.keys('highlight', A), ['/4/2', '/4/8']);
  assert.equal(phone.get('vocab', A, 'ephemeral').dueAt, 99);

  // Same note edited on both: the later edit wins everywhere.
  await tick(); mac.set('highlight', A, '/4/8', { cfi: '/4/8', color: 'blue' });
  await mac.run(s => s.syncNow());
  await tick(); phone.set('highlight', A, '/4/8', { cfi: '/4/8', color: 'yellow' });
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.equal(mac.get('highlight', A, '/4/8').color, 'yellow');
  assert.equal(phone.get('highlight', A, '/4/8').color, 'yellow');
});

test('progress: an edit noticed earlier wins even if it syncs later (offline device)', async () => {
  const B = 'sha256:B';
  const mac = device('mac', [B]);
  const phone = device('phone', [B]);
  await mac.run(s => s.signIn('two@x.com', 'pw', true));
  await phone.run(s => s.signIn('two@x.com', 'pw', false));

  // Phone reads to 30% while "offline": the change is noticed, but the sync fails.
  phone.set('progress', B, '', { lastCfi: 'p30', progress: 0.3 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).startsWith(base) ? Promise.reject(new TypeError('offline')) : realFetch(url, opts);
  globalThis.localStorage = phone.ls;
  await phone.sync.syncNow();
  assert.match(phone.sync.status().lastError, /offline/);
  globalThis.fetch = realFetch;

  // Later, the Mac reads to 60% and syncs first.
  await tick();
  mac.set('progress', B, '', { lastCfi: 'p60', progress: 0.6 });
  await mac.run(s => s.syncNow());

  // Phone comes back online: its older reading must not overwrite the Mac's.
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.equal(phone.get('progress', B, '').progress, 0.6);
  assert.equal(mac.get('progress', B, '').progress, 0.6);

  // An untouched book (no progress item) never deletes progress elsewhere.
  phone.del('progress', B, '');
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.equal(mac.get('progress', B, '').progress, 0.6);
});

test('journal: each device keeps its own day; reflections are shared', async () => {
  const mac = device('mac', []);
  const phone = device('phone', []);
  await mac.run(s => s.signIn('three@x.com', 'pw', true));
  await phone.run(s => s.signIn('three@x.com', 'pw', false));

  mac.set('journal', GLOBAL, `2026-11-26|${mac.sync.deviceId}`, { books: { 'sha256:C': { seconds: 600 } } });
  phone.set('journal', GLOBAL, `2026-11-26|${phone.sync.deviceId}`, { books: { 'sha256:C': { seconds: 300 } } });
  mac.set('reflection', GLOBAL, '2026-11-26', { reflection: 'from the mac', aiReflection: '' });
  await mac.run(s => s.syncNow());
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());

  // Both devices hold both logs, untouched, so the view can add them up.
  for (const d of [mac, phone]) {
    assert.equal(d.get('journal', GLOBAL, `2026-11-26|${mac.sync.deviceId}`).books['sha256:C'].seconds, 600, d.label);
    assert.equal(d.get('journal', GLOBAL, `2026-11-26|${phone.sync.deviceId}`).books['sha256:C'].seconds, 300, d.label);
  }
  assert.equal(phone.get('reflection', GLOBAL, '2026-11-26').reflection, 'from the mac');

  // More reading on the phone later the same day updates only the phone's entry.
  phone.set('journal', GLOBAL, `2026-11-26|${phone.sync.deviceId}`, { books: { 'sha256:C': { seconds: 900 } } });
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.equal(mac.get('journal', GLOBAL, `2026-11-26|${phone.sync.deviceId}`).books['sha256:C'].seconds, 900);
  assert.equal(mac.get('journal', GLOBAL, `2026-11-26|${mac.sync.deviceId}`).books['sha256:C'].seconds, 600);
});

test('large pushes are split into batches the server accepts', async () => {
  const D = 'sha256:D';
  const mac = device('mac', [D]);
  const big = 'x'.repeat(40_000);   // 40 KB each: 30 of them are ~1.2 MB, more than one batch
  for (let i = 0; i < 30; i++) mac.set('journal', GLOBAL, `2026-01-${String(i + 1).padStart(2, '0')}|${mac.sync.deviceId}`, { books: { [D]: { sections: [big] } } });
  for (let i = 0; i < 450; i++) mac.set('vocab', D, `w${i}`, { word: `w${i}` });
  await mac.run(s => s.signIn('four@x.com', 'pw', true));
  const phone = device('phone', [D]);
  await phone.run(s => s.signIn('four@x.com', 'pw', false));
  assert.equal(phone.keys('vocab', D).length, 450);
  assert.equal([...phone.items.keys()].filter(k => k.startsWith('journal|')).length, 30);
});
