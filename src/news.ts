/* News: RSS / Atom feeds. Fetching happens in Rust (the feeds send no CORS
   headers); this module only describes feeds and parses what comes back. */

export interface NewsFeed {
  id: string;
  name: string;
  url: string;
  category?: string;      // group heading; custom feeds fall under "My feeds"
  lang: 'en' | 'si';
  topic: string;          // short note shown under the source name
  builtin?: boolean;
}

export interface NewsItem {
  id: string;             // the article link
  feedId: string;
  title: string;
  link: string;
  published: number;      // ms since epoch (0 when the feed gave no date)
  fetchedAt: number;      // when we first saw it
  summary: string;        // plain text, trimmed
  html?: string;          // the feed's full article body, when it ships one
  author?: string;
}

export const DEFAULT_FEEDS: NewsFeed[] = [
  { id: 'myreading', name: 'My Reading', url: 'https://emindu.github.io/personalize-rss/feed.xml', category: 'My Reading', lang: 'en', topic: 'Your personal feed', builtin: true },
  { id: 'island', name: 'The Island', url: 'https://island.lk/feed/', category: 'Sri Lanka News', lang: 'en', topic: 'English-language news', builtin: true },
  { id: 'lnw', name: 'Lanka News Web', url: 'https://lankanewsweb.net/feed/', category: 'Sri Lanka News', lang: 'en', topic: 'News, politics, entertainment, sports', builtin: true },
  { id: 'onlanka', name: 'Onlanka', url: 'https://www.onlanka.com/feed/', category: 'Sri Lanka News', lang: 'en', topic: 'Sri Lankan news and general coverage', builtin: true },
  { id: 'nation', name: 'Nation.lk', url: 'https://www.nation.lk/online/rss.xml', category: 'Sri Lanka News', lang: 'en', topic: 'Sri Lankan news', builtin: true },
  { id: 'lankatruth', name: 'Lanka Truth (Sinhala)', url: 'https://lankatruth.com/si/?feed=rss2', category: 'Sri Lanka News', lang: 'si', topic: 'Sinhala news', builtin: true },
  { id: 'lbo', name: 'Lanka Business Online', url: 'https://www.lankabusinessonline.com/feed/', category: 'Business', lang: 'en', topic: 'Business and economics', builtin: true },
  { id: 'lmd', name: 'LMD (Lanka Monthly Digest)', url: 'https://lmd.lk/feed/', category: 'Business', lang: 'en', topic: 'Business and interviews', builtin: true },
  { id: 'prageng', name: 'The Pragmatic Engineer', url: 'https://newsletter.pragmaticengineer.com/feed', category: 'Tech & AI', lang: 'en', topic: 'Software engineering', builtin: true },
  { id: 'aheadai', name: 'Ahead of AI (Sebastian Raschka)', url: 'https://magazine.sebastianraschka.com/feed', category: 'Tech & AI', lang: 'en', topic: 'Machine learning', builtin: true },
  { id: 'latentspace', name: 'Latent Space', url: 'https://latent.space/feed', category: 'Tech & AI', lang: 'en', topic: 'AI engineering', builtin: true },
  { id: 'fowler', name: 'Martin Fowler', url: 'https://martinfowler.com/feed.atom', category: 'Tech & AI', lang: 'en', topic: 'Software design', builtin: true },
  { id: 'netflixtech', name: 'Netflix Tech Blog', url: 'https://netflixtechblog.com/feed', category: 'Tech & AI', lang: 'en', topic: 'Engineering at Netflix', builtin: true },
  { id: 'economynext', name: 'EconomyNext', url: 'https://economynext.com/feed/', category: 'Economy & Finance', lang: 'en', topic: 'Sri Lankan economy', builtin: true },
  { id: 'cbsl', name: 'Central Bank of Sri Lanka', url: 'https://www.cbsl.gov.lk/en/rss.xml', category: 'Economy & Finance', lang: 'en', topic: 'Central bank announcements', builtin: true },
  { id: 'netinterest', name: 'Net Interest', url: 'https://www.netinterest.co/feed', category: 'Economy & Finance', lang: 'en', topic: 'Finance newsletter', builtin: true },
  { id: 'vikalpa', name: 'Vikalpa', url: 'https://www.vikalpa.org/feed/', category: 'Civic & Perspectives', lang: 'en', topic: 'Civic issues and other perspectives', builtin: true },
  { id: 'gtrendslk', name: 'Google Trends (Sri Lanka)', url: 'https://trends.google.com/trending/rss?geo=LK', category: 'Trending', lang: 'en', topic: 'What Sri Lanka is searching for today', builtin: true },
  { id: 'elakiri', name: 'ElaKiri forum', url: 'https://elakiri.com/forums/-/index.rss', category: 'Trending', lang: 'en', topic: 'Forum threads: gossip, politics, everyday talk', builtin: true },
];

export const CATEGORY_ORDER = ['My Reading', 'Sri Lanka News', 'Trending', 'Business', 'Tech & AI', 'Economy & Finance', 'Civic & Perspectives'];

/** HTML (or plain text) -> collapsed plain text. */
export function plainText(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach(n => n.remove());
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstText(parent: Element, localNames: string[]): string {
  for (const name of localNames) {
    const el = parent.getElementsByTagNameNS('*', name)[0];
    const t = el?.textContent?.trim();
    if (t) return t;
  }
  return '';
}

function parseDate(text: string): number {
  if (!text) return 0;
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : 0;
}

/** Parse an RSS 2.0 or Atom document into items (newest first). Throws if it is neither. */
export function parseFeed(xml: string, feed: NewsFeed): NewsItem[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('not a valid feed');
  const now = Date.now();
  const nodes = Array.from(doc.getElementsByTagNameNS('*', 'item')).concat(Array.from(doc.getElementsByTagNameNS('*', 'entry')));
  if (nodes.length === 0) throw new Error('no articles in this feed');

  const items: NewsItem[] = [];
  for (const node of nodes) {
    let link = firstText(node, ['link']);
    if (!link) {
      // Atom: <link href="..."/>; prefer rel="alternate".
      const links = Array.from(node.getElementsByTagNameNS('*', 'link'));
      const alt = links.find(l => (l.getAttribute('rel') || 'alternate') === 'alternate') ?? links[0];
      link = alt?.getAttribute('href') || '';
    }
    // Google Trends: every item links to the feed itself; the real article is
    // the first linked news story, whose headline makes the summary.
    const trendUrl = firstText(node, ['news_item_url']);
    const trendHead = firstText(node, ['news_item_title']);
    const trendSource = firstText(node, ['news_item_source']);
    const traffic = firstText(node, ['approx_traffic']);
    if (trendUrl) link = trendUrl;
    link = link.trim();
    if (!/^https?:\/\//i.test(link)) continue;
    const title = plainText(firstText(node, ['title'])) || link;
    const body = firstText(node, ['encoded', 'content']);
    const desc = firstText(node, ['description', 'summary']);
    // WordPress appends "The post X appeared first on Y." to every excerpt.
    let summary = plainText(desc || body).replace(/\s*The post .{0,300}? appeared first on .*$/i, '').slice(0, 400);
    if (trendUrl) {
      summary = [traffic && `${traffic} searches`, trendHead && `${trendHead}${trendSource ? ` (${trendSource})` : ''}`].filter(Boolean).join(' · ');
    }
    items.push({
      id: link,
      feedId: feed.id,
      title,
      link,
      published: parseDate(firstText(node, ['pubDate', 'published', 'updated', 'date'])),
      fetchedAt: now,
      summary,
      html: body && plainText(body).length > 600 ? body : undefined,
      author: firstText(node, ['creator', 'author', 'name']) || undefined,
    });
  }
  items.sort((a, b) => b.published - a.published);
  return items;
}

export function timeAgo(ms: number, now = Date.now()): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
