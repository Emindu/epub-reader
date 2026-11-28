// The e-reader (OPDS) feed, end to end against the in-memory store.
//   npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createApp } from './server.mjs';
import { MemoryStore } from './store.mjs';
import { MemoryFiles } from './files.mjs';
import { fileStem, disposition, hashToken, FailureLimiter } from './opds.mjs';

let server, base, store;
const files = new MemoryFiles();
before(async () => {
  store = new MemoryStore();
  const handle = createApp({
    store,
    files,
    verifyToken: async t => { if (!t.startsWith('dev:')) throw new Error('bad'); return t.slice(4); },
    opds: { maxFailures: 3, linkDays: 90 },
  });
  server = http.createServer(handle);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  files.base = base;
});
after(() => server.close());

const sha = s => createHash('sha256').update(s).digest('hex');
const COVER = 'data:image/jpeg;base64,' + Buffer.from('not-really-a-jpeg').toString('base64');

async function api(method, path, user, body) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer dev:${user}` },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** A library entry, plus (optionally) its file in storage, the way the app syncs them. */
async function addBook(user, key, data, bytes) {
  const item = { id: sha('book|*|' + key), kind: 'book', book: '*', key, updatedAt: Date.now(), data };
  assert.equal((await api('POST', '/v1/sync', user, { items: [item] })).status, 200);
  if (bytes) {
    const up = await api('POST', '/v1/files/upload', user, { book: key, contentType: 'application/octet-stream' });
    assert.equal((await fetch(up.json.url, { method: 'PUT', body: bytes })).status, 200);
  }
  return item.id;
}

const feedOf = async user => (await api('POST', '/v1/feed', user)).json;
let nextIp = 1;
/** An e-reader request: HTTP Basic with the token as password, from its own address. */
const reader = (token, ip = `10.0.0.${nextIp++}`) => (path, init = {}) => fetch(base + path, {
  redirect: 'manual',
  ...init,
  headers: {
    'X-Forwarded-For': ip,
    ...(token ? { Authorization: 'Basic ' + Buffer.from('read:' + token).toString('base64') } : {}),
    ...(init.headers || {}),
  },
});

test('a feed password needs a signed-in user', async () => {
  const res = await fetch(`${base}/v1/feed`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('creating a password returns it once, with an expiry, and the server keeps only its hash', async () => {
  const f = await feedOf('zed');
  assert.equal(f.user, 'read');
  assert.equal(f.path, '/opds/');
  assert.match(f.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(f.expiresAt > Date.now() + 80 * 86400_000 && f.expiresAt < Date.now() + 100 * 86400_000);
  const stored = await store.feedForUser('zed');
  assert.equal(stored.hash, hashToken(f.token));
  assert.notEqual(stored.hash, f.token);
  assert.deepEqual((await api('GET', '/v1/feed', 'zed')).json, { active: true, expiresAt: f.expiresAt });
});

test('without credentials the catalogue answers with a Basic challenge, and the secret is never read from a URL', async () => {
  const f = await feedOf('ann0');
  const res = await reader(null)('/opds/');
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /^Basic realm=/);
  // The token in the path does nothing unless that mode is switched on.
  assert.equal((await reader(null)(`/opds/${f.token}/`)).status, 401);
});

test('the catalogue lists books that have a stored file, and only those', async () => {
  const { token } = await feedOf('ann');
  await addBook('ann', 'sha256:one', { title: 'Superintelligence', author: 'Nick Bostrom', format: 'epub', cover: COVER }, Buffer.from('EPUBDATA'));
  await addBook('ann', 'sha256:two', { title: 'Notes', format: 'md', sourceUrl: 'https://example.com/a?x=1&y=2' }, Buffer.from('# hi'));
  await addBook('ann', 'sha256:nofile', { title: 'Never uploaded', format: 'pdf' });

  const res = await reader(token)('/opds/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/atom\+xml;profile=opds-catalog/);
  const xml = await res.text();
  assert.match(xml, /<title>Superintelligence<\/title>/);
  assert.match(xml, /<name>Nick Bostrom<\/name>/);
  assert.match(xml, /type="application\/epub\+zip"/);
  assert.match(xml, /type="text\/markdown"/);
  assert.match(xml, /example\.com\/a\?x=1&amp;y=2/);     // escaped
  assert.doesNotMatch(xml, /Never uploaded/);
  assert.match(xml, /opds-spec\.org\/image\/thumbnail/);
  assert.doesNotMatch(xml, new RegExp(token), 'the secret never appears in the catalogue');
});

test('a download streams the file under a real name, with no redirect to another host', async () => {
  const { token } = await feedOf('bob');
  const id = await addBook('bob', 'sha256:bk', { title: 'Dune: Messiah?', format: 'epub' }, Buffer.from('EPUBDATA'));
  const get = reader(token);
  const xml = await (await get('/opds/')).text();
  const href = new RegExp(`href="([^"]*/get/${id}/[^"]+)"`).exec(xml)?.[1];
  assert.ok(href, 'acquisition link present');
  assert.doesNotMatch(href, new RegExp(token));

  const res = await get(new URL(href).pathname);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('location'), null);
  assert.equal(res.headers.get('content-type'), 'application/epub+zip');
  assert.equal(res.headers.get('content-length'), '8');
  assert.match(res.headers.get('content-disposition'), /filename="Dune Messiah\.epub"/);
  assert.equal(await res.text(), 'EPUBDATA');

  assert.equal((await reader(null)(new URL(href).pathname)).status, 401);   // the file needs the password too
});

test('the cover is served from the library entry', async () => {
  const { token } = await feedOf('cat');
  const id = await addBook('cat', 'sha256:cv', { title: 'Covered', format: 'epub', cover: COVER }, Buffer.from('x'));
  const res = await reader(token)(`/opds/cover/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(await res.text(), 'not-really-a-jpeg');
});

test('passwords are private: wrong ones, other users, and replaced ones are all refused alike', async () => {
  const a = await feedOf('dan');
  const id = await addBook('dan', 'sha256:priv', { title: 'Private', format: 'epub' }, Buffer.from('SECRET'));
  assert.equal((await reader(a.token)('/opds/')).status, 200);
  const wrong = await reader('A'.repeat(43))('/opds/');
  const short = await reader('short')('/opds/');
  assert.equal(wrong.status, 401);
  assert.equal(short.status, 401);
  assert.equal(await wrong.text(), await short.text());

  const other = await feedOf('eve');
  assert.doesNotMatch(await (await reader(other.token)('/opds/')).text(), /Private/);
  assert.equal((await reader(other.token)(`/opds/get/${id}/x.epub`)).status, 404);

  // Asking again replaces the password: the old one stops working at once.
  const b = await feedOf('dan');
  assert.notEqual(a.token, b.token);
  assert.equal((await reader(a.token)('/opds/')).status, 401);
  assert.equal((await reader(b.token)('/opds/')).status, 200);
});

test('a password stops working when it expires', async () => {
  const token = 'E'.repeat(43);
  await store.setFeedToken('fred', hashToken(token), Date.now() + 60_000);
  assert.equal((await reader(token)('/opds/')).status, 200);
  await store.setFeedToken('fred', hashToken(token), Date.now() - 1);
  assert.equal((await reader(token)('/opds/')).status, 401);
  const st = await store.feedForUser('fred');
  assert.deepEqual((await api('GET', '/v1/feed', 'fred')).json, { active: false, expiresAt: st.expiresAt });
});

test('revoking stops the password at once and the app can see it is off', async () => {
  const { token } = await feedOf('gus');
  assert.equal((await reader(token)('/opds/')).status, 200);
  const res = await api('POST', '/v1/feed/revoke', 'gus');
  assert.deepEqual(res.json, { active: false, expiresAt: null });
  assert.equal((await reader(token)('/opds/')).status, 401);
  assert.deepEqual((await api('GET', '/v1/feed', 'gus')).json, { active: false, expiresAt: null });
  assert.equal((await api('POST', '/v1/feed/revoke', 'gus')).status, 200);   // revoking twice is fine
});

test('repeated bad passwords from one address are blocked, others are not', async () => {
  const { token } = await feedOf('hal');
  const bad = reader('B'.repeat(43), '203.0.113.9');
  for (let n = 0; n < 3; n++) assert.equal((await bad('/opds/')).status, 401);
  const blocked = await bad('/opds/');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // That address is blocked even with the right password; a different address is fine.
  assert.equal((await reader(token, '203.0.113.9')('/opds/')).status, 429);
  assert.equal((await reader(token, '198.51.100.7')('/opds/')).status, 200);
});

test('a book removed from the library disappears from the catalogue', async () => {
  const { token } = await feedOf('fay');
  const id = await addBook('fay', 'sha256:gone', { title: 'Gone soon', format: 'epub' }, Buffer.from('x'));
  assert.match(await (await reader(token)('/opds/')).text(), /Gone soon/);
  const del = { id, kind: 'book', book: '*', key: 'sha256:gone', updatedAt: Date.now() + 5000, deleted: true };
  assert.equal((await api('POST', '/v1/sync', 'fay', { items: [del] })).status, 200);
  assert.doesNotMatch(await (await reader(token)('/opds/')).text(), /Gone soon/);
});

test('file names are safe and keep any language', () => {
  assert.equal(fileStem('Why? A/B: "tests"'), 'Why A B tests');
  assert.equal(fileStem('  ...hidden'), 'hidden');
  assert.equal(fileStem(''), 'book');
  assert.equal(fileStem('සිංහල පොත'), 'සිංහල පොත');
  assert.ok(fileStem('x'.repeat(300)).length <= 80);
  const d = disposition('සිංහල "x".epub');
  assert.match(d, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
  assert.doesNotMatch(d, /\n|\r/);
  assert.match(d, /%E0%B7%83/);
});

test('the failure limiter forgets after its window', () => {
  let t = 0;
  const lim = new FailureLimiter({ maxFailures: 2, windowMs: 1000, now: () => t });
  lim.fail('ip'); lim.fail('ip');
  assert.ok(lim.blocked('ip') > 0);
  assert.equal(lim.blocked('other'), 0);
  t = 1001;
  assert.equal(lim.blocked('ip'), 0);
});

test('OPDS_ALLOW_URL_TOKEN: the token in the path works only when that mode is on', async () => {
  const handle = createApp({
    store, files, verifyToken: async t => t.slice(4), opds: { allowUrlToken: true },
  });
  const second = http.createServer(handle);
  await new Promise(r => second.listen(0, r));
  const url = `http://127.0.0.1:${second.address().port}`;
  try {
    const { token } = await feedOf('ida');
    const viaPath = await fetch(`${url}/opds/${token}/`, { headers: { 'X-Forwarded-For': '10.9.9.1' } });
    assert.equal(viaPath.status, 200);
    assert.ok((await viaPath.text()).includes(`${url}/opds/${token}/"`), "links keep the token prefix in this mode");
    // Basic auth still works on that server too.
    const basic = await fetch(`${url}/opds/`, { headers: { 'X-Forwarded-For': '10.9.9.2', Authorization: 'Basic ' + Buffer.from('x:' + token).toString('base64') } });
    assert.equal(basic.status, 200);
  } finally {
    second.close();
  }
});
