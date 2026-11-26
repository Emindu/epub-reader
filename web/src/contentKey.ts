/* Content keys: an ID for a library item that is the same on every device.

   A BookRecord's `id` is a random UUID made at import, so the same EPUB on two
   devices has two ids. Sync matches items by `contentKey` instead:

     sha256:<hex>   books, documents and pasted text (hash of the stored bytes)
     url:<url>      saved web articles (normalised source URL)

   Hashing the bytes rather than using EPUB dc:identifier is deliberate:
   highlights are stored as CFIs, which only point at the same text in an
   identical file, and dc:identifier is often missing or shared between
   editions.

   Pure functions with no app state, so web/ can copy this file as-is. */

export async function sha256Key(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

// Query parameters that only track where a click came from.
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;
// X/Twitter post links carry share parameters (?s=20&t=…); the post id is in the path.
const X_HOST = /^(x|twitter|mobile\.twitter)\.com$/;

/** Same article, same key: drops the #fragment, tracking parameters, `www.` and a trailing slash. */
export function articleKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    if (X_HOST.test(u.hostname)) {
      u.hostname = 'x.com';
      u.search = '';
    }
    for (const name of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(name)) u.searchParams.delete(name);
    }
    u.searchParams.sort();
    let s = u.toString();
    if (u.pathname.length > 1 && s.endsWith('/') && !u.search) s = s.slice(0, -1);
    return `url:${s}`;
  } catch {
    return `url:${url.trim()}`;
  }
}
