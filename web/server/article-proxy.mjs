// Article fetcher for the "Save article" importer.
//
// Browsers can't fetch arbitrary pages cross-origin (CORS), so the web app
// asks this endpoint for the raw HTML instead. The desktop app does the same
// job in Rust with curl; this is the web equivalent.
//
// Because this endpoint fetches whatever URL it's given, it is hardened:
//   - only http/https, only the standard ports
//   - every hostname is resolved and rejected if it points at a private,
//     loopback, link-local or otherwise non-public address (SSRF guard)
//   - redirects are followed manually so each hop gets the same check
//   - a hard timeout and a 20 MB response cap
//   - callers must send a custom header; cross-origin pages can't add it
//     without a CORS preflight, which this server never grants, so other
//     websites can't use this server as an open proxy from a visitor's browser

import dns from 'node:dns/promises';
import net from 'node:net';

export const ARTICLE_PATH = '/api/article';
export const DICTIONARY_PATH = '/api/dictionary';
const DICTIONARY_API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const REQUIRED_HEADER = 'x-read-client';
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||                          // "this" network
      a === 10 ||                         // private
      a === 127 ||                        // loopback
      (a === 169 && b === 254) ||         // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) ||         // private
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      a >= 224                            // multicast + reserved
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped addresses (::ffff:10.0.0.1) — check the embedded v4 part.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^f[cd]/.test(lower)) return true;        // unique local fc00::/7
    if (/^fe[89ab]/.test(lower)) return true;     // link-local fe80::/10
    if (/^ff/.test(lower)) return true;           // multicast
    return false;
  }
  return true; // not an IP at all — treat as unsafe
}

async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('That address is not publicly reachable.');
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve ${hostname}.`);
  }
  if (addresses.length === 0 || addresses.some(a => isPrivateAddress(a.address))) {
    throw new Error('That address is not publicly reachable.');
  }
}

function parseTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported.');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('Only the standard web ports (80/443) are supported.');
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not supported.');
  }
  return url;
}

// Decode with the charset the server declared, falling back to UTF-8. Pages
// that declare nothing are almost always UTF-8 in practice.
function decodeBody(buffer, contentType) {
  const match = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const label = match ? match[1] : 'utf-8';
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// ---- X / Twitter ----------------------------------------------------------
// x.com serves a login wall to anything that isn't a signed-in browser, so a
// plain fetch only ever returns "Log in or sign up for X". The public
// FxTwitter API exposes post text and long-form X Articles as JSON; we turn
// that into simple article HTML for the normal Readability pipeline.

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

function escapeHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Applies Draft.js inline styles + link entities to one block's text.
function renderInline(block, entities) {
  const text = Array.from(block.text || '');
  const n = text.length;
  const bold = new Array(n).fill(false);
  const italic = new Array(n).fill(false);
  const code = new Array(n).fill(false);
  const link = new Array(n).fill(null);
  for (const r of block.inlineStyleRanges || []) {
    const arr = r.style === 'Bold' ? bold : r.style === 'Italic' ? italic : /code|mono/i.test(r.style) ? code : null;
    if (arr) for (let i = r.offset; i < Math.min(n, r.offset + r.length); i++) arr[i] = true;
  }
  for (const r of block.entityRanges || []) {
    const e = entities.get(String(r.key));
    if (e && e.type === 'LINK' && e.data && /^https?:\/\//i.test(e.data.url || '')) {
      for (let i = r.offset; i < Math.min(n, r.offset + r.length); i++) link[i] = e.data.url;
    }
  }
  let out = '';
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && bold[j] === bold[i] && italic[j] === italic[i] && code[j] === code[i] && link[j] === link[i]) j++;
    let seg = escapeHtml(text.slice(i, j).join('')).replace(/\n/g, '<br>');
    if (code[i]) seg = '<code>' + seg + '</code>';
    if (bold[i]) seg = '<strong>' + seg + '</strong>';
    if (italic[i]) seg = '<em>' + seg + '</em>';
    if (link[i]) seg = '<a href="' + escapeHtml(link[i]) + '">' + seg + '</a>';
    out += seg;
    i = j;
  }
  return out;
}

function articleToHtml(tweet) {
  const a = tweet.article;
  const entities = new Map();
  const em = a.content && a.content.entityMap;
  if (Array.isArray(em)) for (const e of em) entities.set(String(e.key), e.value);
  else if (em) for (const k of Object.keys(em)) entities.set(k, em[k]);

  const media = new Map();
  for (const m of a.media_entities || []) media.set(String(m.media_id), m.media_info || {});
  const mediaHtml = (info, caption) => {
    const src = info.original_img_url || info.preview_image_url || (info.thumbnail && info.thumbnail.url) || '';
    if (!/^https:\/\//.test(src)) return '';
    return '<figure><img src="' + escapeHtml(src) + '" alt="' + escapeHtml(caption || '') + '">' +
      (caption ? '<figcaption>' + escapeHtml(caption) + '</figcaption>' : '') + '</figure>';
  };

  let html = '';
  let list = null;
  const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
  if (a.cover_media && a.cover_media.media_info) html += mediaHtml(a.cover_media.media_info, '');

  for (const b of (a.content && a.content.blocks) || []) {
    const t = b.type;
    if (t === 'unordered-list-item' || t === 'ordered-list-item') {
      const want = t === 'unordered-list-item' ? 'ul' : 'ol';
      if (list !== want) { closeList(); html += '<' + want + '>'; list = want; }
      html += '<li>' + renderInline(b, entities) + '</li>';
      continue;
    }
    closeList();
    if (t === 'atomic') {
      for (const r of b.entityRanges || []) {
        const e = entities.get(String(r.key));
        if (!e) continue;
        if (e.type === 'MEDIA') {
          const item = (e.data.mediaItems || [])[0];
          const info = item && media.get(String(item.mediaId));
          if (info) html += mediaHtml(info, e.data.caption);
        } else if (e.type === 'MARKDOWN' && e.data && e.data.markdown) {
          const body = e.data.markdown.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
          html += '<pre><code>' + escapeHtml(body) + '</code></pre>';
        }
      }
    } else if (t === 'header-one') html += '<h2>' + renderInline(b, entities) + '</h2>';
    else if (t === 'header-two') html += '<h3>' + renderInline(b, entities) + '</h3>';
    else if (t === 'header-three') html += '<h4>' + renderInline(b, entities) + '</h4>';
    else if (t === 'blockquote') html += '<blockquote>' + renderInline(b, entities) + '</blockquote>';
    else if (t === 'code-block') html += '<pre><code>' + escapeHtml(b.text || '') + '</code></pre>';
    else if ((b.text || '').trim()) html += '<p>' + renderInline(b, entities) + '</p>';
  }
  closeList();
  return html;
}

async function fetchXHtml(url) {
  const m = /^\/(?:[^/]+|i\/web)\/status(?:es)?\/(\d+)/.exec(url.pathname);
  if (!m) throw new Error('Paste a link to a specific post on X (…/status/…).');
  const res = await fetch('https://api.fxtwitter.com/status/' + m[1], {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Read-app', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error('Could not load that post from X (HTTP ' + res.status + ').');
  const tweet = (await res.json()).tweet;
  if (!tweet) throw new Error('That post could not be found.');

  const author = tweet.author || {};
  const by = (author.name || '') + (author.screen_name ? ' (@' + author.screen_name + ')' : '');
  let title;
  let body;
  if (tweet.article && tweet.article.content) {
    title = tweet.article.title || 'X article';
    body = articleToHtml(tweet);
  } else {
    const raw = tweet.text || '';
    title = (by || 'Post on X') + ': ' + raw.slice(0, 60).replace(/\s+/g, ' ');
    body = raw.split(/\n{2,}/).map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('');
    for (const p of (tweet.media && tweet.media.photos) || []) {
      if (/^https:\/\//.test(p.url || '')) body += '<figure><img src="' + escapeHtml(p.url) + '" alt=""></figure>';
    }
  }
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(title) +
    '</title><meta name="author" content="' + escapeHtml(by) + '"></head><body><article><h1>' +
    escapeHtml(title) + '</h1><p class="byline">' + escapeHtml(by) + '</p>' + body + '</article></body></html>';
}

/**
 * Fetch a page's HTML. Throws an Error with a user-readable message on any
 * failure, so the caller can show it directly.
 */
export async function fetchArticleHtml(rawUrl) {
  let url = parseTarget(rawUrl);
  if (X_HOSTS.has(url.hostname.toLowerCase())) return fetchXHtml(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);

    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = parseTarget(new URL(res.headers.get('location'), url).toString());
      continue;
    }
    if (!res.ok) {
      throw new Error(`The site responded with HTTP ${res.status}.`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error('That link is not a web page.');
    }

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error('That page is too large to import.');

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) {
        await reader.cancel();
        throw new Error('That page is too large to import.');
      }
      chunks.push(value);
    }
    if (received === 0) throw new Error('The page returned no content.');

    const body = Buffer.concat(chunks.map(c => Buffer.from(c)));
    return decodeBody(body, contentType);
  }
  throw new Error('Too many redirects.');
}

/**
 * Connect-style middleware: `(req, res, next)`. Works in both the Vite dev
 * server and the plain Node production server.
 */
/**
 * Looks up an English word in the free dictionary API. The browser can't call
 * that API directly (it sends no CORS header), so the server does. Returns
 * { status, body }: 200 when found, 404 when the word is unknown.
 */
export async function fetchDictionaryEntry(word) {
  if (!/^[a-zA-Z][a-zA-Z'-]{0,63}$/.test(word)) {
    return { status: 400, body: 'Invalid word' };
  }
  const res = await fetch(DICTIONARY_API + encodeURIComponent(word), {
    signal: AbortSignal.timeout(10_000),
    headers: { 'Accept': 'application/json' },
  });
  return { status: res.status, body: await res.text() };
}

export function articleMiddleware(req, res, next) {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (pathname === DICTIONARY_PATH) return dictionaryMiddleware(req, res);
  if (pathname !== ARTICLE_PATH) return next();

  const send = (status, text) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
  };

  if (req.method !== 'GET') return send(405, 'Method not allowed');
  if (!req.headers[REQUIRED_HEADER]) return send(403, 'Missing client header');

  const target = new URL(req.url, 'http://local').searchParams.get('url') || '';
  fetchArticleHtml(target)
    .then(html => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(html);
    })
    .catch(err => send(422, err instanceof Error ? err.message : String(err)));
}

function dictionaryMiddleware(req, res) {
  const send = (status, type, text) => {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
  };
  if (req.method !== 'GET') return send(405, 'text/plain; charset=utf-8', 'Method not allowed');
  if (!req.headers[REQUIRED_HEADER]) return send(403, 'text/plain; charset=utf-8', 'Missing client header');

  const word = new URL(req.url, 'http://local').searchParams.get('word') || '';
  fetchDictionaryEntry(word)
    .then(({ status, body }) => send(status, 'application/json; charset=utf-8', body))
    .catch(() => send(502, 'text/plain; charset=utf-8', 'Dictionary service unavailable'));
}
