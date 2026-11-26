// X / Twitter importer support. x.com serves a login wall to anything that
// isn't a signed-in browser, so a plain page fetch only returns "Log in or
// sign up for X". The public FxTwitter API exposes post text and long-form X
// Articles as JSON; we turn that into simple article HTML for Readability.

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

/** The status id when `url` is an X/Twitter post link; null for any other URL. */
export function xStatusId(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = /^\/(?:[^/]+|i\/web)\/status(?:es)?\/(\d+)/.exec(u.pathname);
  return m ? m[1] : null;
}

export function isXUrl(url: string): boolean {
  try { return X_HOSTS.has(new URL(url).hostname.toLowerCase()); } catch { return false; }
}

export function fxApiUrl(id: string): string {
  return `https://api.fxtwitter.com/status/${id}`;
}

function esc(t: string): string {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderInline(block: any, entities: Map<string, any>): string {
  const text: string[] = Array.from(block.text || '');
  const n = text.length;
  const bold = new Array<boolean>(n).fill(false);
  const italic = new Array<boolean>(n).fill(false);
  const code = new Array<boolean>(n).fill(false);
  const link = new Array<string | null>(n).fill(null);
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
    let seg = esc(text.slice(i, j).join('')).replace(/\n/g, '<br>');
    if (code[i]) seg = `<code>${seg}</code>`;
    if (bold[i]) seg = `<strong>${seg}</strong>`;
    if (italic[i]) seg = `<em>${seg}</em>`;
    if (link[i]) seg = `<a href="${esc(link[i]!)}">${seg}</a>`;
    out += seg;
    i = j;
  }
  return out;
}

function articleToHtml(a: any): string {
  const entities = new Map<string, any>();
  const em = a.content?.entityMap;
  if (Array.isArray(em)) for (const e of em) entities.set(String(e.key), e.value);
  else if (em) for (const k of Object.keys(em)) entities.set(k, em[k]);

  const media = new Map<string, any>();
  for (const m of a.media_entities || []) media.set(String(m.media_id), m.media_info || {});
  const mediaHtml = (info: any, caption?: string): string => {
    const src = info.original_img_url || info.preview_image_url || info.thumbnail?.url || '';
    if (!/^https:\/\//.test(src)) return '';
    return `<figure><img src="${esc(src)}" alt="${esc(caption || '')}">` +
      (caption ? `<figcaption>${esc(caption)}</figcaption>` : '') + '</figure>';
  };

  let html = '';
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  if (a.cover_media?.media_info) html += mediaHtml(a.cover_media.media_info);

  for (const b of a.content?.blocks || []) {
    const t = b.type;
    if (t === 'unordered-list-item' || t === 'ordered-list-item') {
      const want = t === 'unordered-list-item' ? 'ul' : 'ol';
      if (list !== want) { closeList(); html += `<${want}>`; list = want; }
      html += `<li>${renderInline(b, entities)}</li>`;
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
        } else if (e.type === 'MARKDOWN' && e.data?.markdown) {
          const body = String(e.data.markdown).replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
          html += `<pre><code>${esc(body)}</code></pre>`;
        }
      }
    } else if (t === 'header-one') html += `<h2>${renderInline(b, entities)}</h2>`;
    else if (t === 'header-two') html += `<h3>${renderInline(b, entities)}</h3>`;
    else if (t === 'header-three') html += `<h4>${renderInline(b, entities)}</h4>`;
    else if (t === 'blockquote') html += `<blockquote>${renderInline(b, entities)}</blockquote>`;
    else if (t === 'code-block') html += `<pre><code>${esc(b.text || '')}</code></pre>`;
    else if ((b.text || '').trim()) html += `<p>${renderInline(b, entities)}</p>`;
  }
  closeList();
  return html;
}

/** Converts an FxTwitter API JSON response into a small standalone article page. */
export function xApiJsonToHtml(json: string): string {
  const tweet = JSON.parse(json).tweet;
  if (!tweet) throw new Error('That post could not be found.');
  const author = tweet.author || {};
  const by = (author.name || '') + (author.screen_name ? ` (@${author.screen_name})` : '');
  let title: string;
  let body: string;
  if (tweet.article?.content) {
    title = tweet.article.title || 'X article';
    body = articleToHtml(tweet.article);
  } else {
    const raw: string = tweet.text || '';
    title = `${by || 'Post on X'}: ${raw.slice(0, 60).replace(/\s+/g, ' ')}`;
    body = raw.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    for (const p of tweet.media?.photos || []) {
      if (/^https:\/\//.test(p.url || '')) body += `<figure><img src="${esc(p.url)}" alt=""></figure>`;
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<meta name="author" content="${esc(by)}"></head><body><article><h1>${esc(title)}</h1>` +
    `<p class="byline">${esc(by)}</p>${body}</article></body></html>`;
}
