// Fetches a web page's HTML through the app's own server, since browsers
// block cross-origin page reads. See server/article-proxy.mjs for the server
// side and the safety checks it applies.

export async function fetchArticleHtml(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api/article?url=${encodeURIComponent(url)}`, {
      headers: { 'X-Read-Client': '1' },
    });
  } catch {
    throw new Error("Couldn't reach the Read server. Is it running?");
  }
  if (res.status === 404) {
    throw new Error('Saving articles needs the Read web server (npm start), not a static file host.');
  }
  if (!res.ok) {
    throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  }
  return res.text();
}
