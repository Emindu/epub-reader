// The app's sync module (src/sync.ts) driving two simulated devices through this
// server with an in-memory store. Node runs the .ts file directly (type stripping,
// Node >= 23.6). Firebase sign-in is faked: tokens are "dev:<uid>".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './server.mjs';
import { MemoryStore } from './store.mjs';
import { Sync } from '../src/sync.ts';

// --- fake browser bits ---
class LS { constructor(){ this.m=new Map(); } getItem(k){ return this.m.has(k)?this.m.get(k):null; } setItem(k,v){ this.m.set(k,String(v)); } removeItem(k){ this.m.delete(k); } }
globalThis.window = { setTimeout, clearTimeout, setInterval: () => 0, addEventListener(){} };
globalThis.document = { addEventListener(){}, visibilityState: 'visible' };

const server = http.createServer(createApp({ store: new MemoryStore(), verifyToken: async t => { if (!t.startsWith('dev:')) throw 0; return t.slice(4); } }));
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('identitytoolkit')) {
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ localId: 'u-' + body.email, email: body.email, idToken: 'dev:u-' + body.email, refreshToken: 'r', expiresIn: '3600' }), { status: 200 });
  }
  return realFetch(url, opts);
};

function device(name, books) {
  const ls = new LS();
  const marks = new Map(books.map(b => [b.id, { highlights: [], bookmarks: [] }]));
  const dev = { name, ls, marks, books, remoteCalls: 0 };
  const host = {
    books: () => dev.books,
    readMarks: id => structuredClone(marks.get(id) ?? { highlights: [], bookmarks: [] }),
    writeMarks: (id, m) => marks.set(id, structuredClone(m)),
    onRemoteChange: () => { dev.remoteCalls++; },
    onStatus: () => {},
  };
  globalThis.localStorage = ls;
  dev.sync = new Sync({ serviceUrl: base, apiKey: 'k' }, host);
  // every call runs with this device's storage
  dev.run = async fn => { globalThis.localStorage = ls; return fn(dev.sync); };
  return dev;
}
const hl = (cfi, color = 'yellow') => ({ cfi, color, text: 't' + cfi, chapter: 'c', createdAt: 1 });
const cfis = (d, id, kind = 'highlights') => d.marks.get(id)[kind].map(m => m.cfi).sort();

test('two devices converge: adds, edits, deletes, book removal, late import', async () => {
  // Same book, different per-device ids.
  const mac = device('mac', [{ id: 'm1', contentKey: 'sha256:A' }]);
  const phone = device('phone', [{ id: 'p1', contentKey: 'sha256:A' }]);

  mac.marks.get('m1').highlights.push(hl('/4/2'), hl('/4/4'));
  mac.marks.get('m1').bookmarks.push({ cfi: '/6/2', text: 'bm', chapter: 'c', createdAt: 1 });
  await mac.run(s => s.signIn('me@x.com', 'pw', true));
  assert.equal(mac.sync.status().lastError, '');

  // Phone already had a note of its own before signing in.
  phone.marks.get('p1').highlights.push(hl('/4/8'));
  await phone.run(s => s.signIn('me@x.com', 'pw', false));
  assert.deepEqual(cfis(phone, 'p1'), ['/4/2', '/4/4', '/4/8']);
  assert.deepEqual(cfis(phone, 'p1', 'bookmarks'), ['/6/2']);

  await mac.run(s => s.syncNow());
  assert.deepEqual(cfis(mac, 'm1'), ['/4/2', '/4/4', '/4/8']);

  // A sync with nothing new changes nothing and redraws nothing.
  const before = mac.remoteCalls;
  await mac.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.equal(mac.remoteCalls, before, 'no redraw when nothing changed');

  // Phone recolours one, deletes another.
  const pm = phone.marks.get('p1');
  pm.highlights.find(h => h.cfi === '/4/2').color = 'green';
  pm.highlights = pm.highlights.filter(h => h.cfi !== '/4/4');
  await new Promise(r => setTimeout(r, 5));
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.deepEqual(cfis(mac, 'm1'), ['/4/2', '/4/8']);
  assert.equal(mac.marks.get('m1').highlights.find(h => h.cfi === '/4/2').color, 'green');

  // Removing the book on the phone must NOT delete its notes elsewhere.
  phone.books = []; phone.marks.delete('p1');
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  assert.deepEqual(cfis(mac, 'm1'), ['/4/2', '/4/8']);

  // Phone re-imports the book later (new local id): its notes come back by key.
  phone.books = [{ id: 'p2', contentKey: 'sha256:A' }];
  phone.marks.set('p2', { highlights: [], bookmarks: [] });
  await phone.run(s => s.syncNow());
  assert.equal(phone.sync.status().lastError, '');
  assert.deepEqual(cfis(phone, 'p2'), ['/4/2', '/4/8']);
  assert.deepEqual(cfis(phone, 'p2', 'bookmarks'), ['/6/2']);

  // Concurrent edits of one note: the later edit wins on both devices.
  mac.marks.get('m1').highlights.find(h => h.cfi === '/4/8').color = 'blue';
  await mac.run(s => s.syncNow());
  await new Promise(r => setTimeout(r, 5));
  phone.marks.get('p2').highlights.find(h => h.cfi === '/4/8').color = 'pink';
  await phone.run(s => s.syncNow());
  await mac.run(s => s.syncNow());
  for (const [d, id] of [[mac, 'm1'], [phone, 'p2']]) {
    assert.equal(d.marks.get(id).highlights.find(h => h.cfi === '/4/8').color, 'pink', d.name);
  }

  // Sign out keeps notes locally.
  mac.run(s => s.signOut());
  assert.equal(mac.sync.email, null);
  assert.deepEqual(cfis(mac, 'm1'), ['/4/2', '/4/8']);
  server.close();
});
