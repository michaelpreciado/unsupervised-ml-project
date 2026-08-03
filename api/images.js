/**
 * Vercel serverless proxy for the "Pull from Google" tile-library feature.
 *
 * Why a proxy at all? Two reasons, both to do with trust boundaries:
 *   1. The Google Programmable Search (Custom Search JSON) API key must never
 *      ship to the browser — it lives here, server-side, in env vars.
 *   2. The browser canvas is tainted by cross-origin images, so the web demo
 *      cannot read pixels from images hosted on arbitrary Google-indexed
 *      domains. This function fetches the image bytes and returns them as
 *      base64 data-URLs the canvas can safely decode into tiles.
 *
 * Env vars (Vercel project settings):
 *   GOOGLE_CSE_KEY   — Programmable Search JSON API key
 *   GOOGLE_CSE_CX    — the Programmable Search Engine ID (cx)
 *
 * When those are not configured, the function reports a clean 503 and the
 * client falls back to the bundled demo atlas instead of erroring out.
 */

const MAX_TILES = 200;
const MAX_BYTES_PER_IMAGE = 2 * 1024 * 1024; // 2 MB each, generous headroom
const FETCH_TIMEOUT_MS = 8000;

function parseN(v) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_TILES) : 40;
}

/** Crawl Google's "next" page links to gather up to n real image URLs. */
async function gatherImageUrls(key, cx, query, n) {
  const urls = [];
  let start = 1;
  while (urls.length < n && start <= 91) {
    const want = Math.min(10, n - urls.length);
    const params = new URLSearchParams({
      key, cx,
      q: query,
      searchType: 'image',
      imgSize: 'medium',
      num: String(want),
      start: String(start),
      safe: 'active',
    });
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Google Custom Search failed (${res.status})`);
    }
    const data = await res.json();
    if (!Array.isArray(data.items)) break;
    for (const item of data.items) {
      const link = item?.link;
      if (typeof link === 'string' && /^https?:\/\//i.test(link)) {
        urls.push(link);
      }
    }
    if (!Array.isArray(data.queries?.nextPage)) break;
    start = Number(data.queries.nextPage[0].startIndex);
  }
  return urls.slice(0, n);
}

/** Download one image and base64-encode it for safe canvas decoding. */
async function proxyImage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Some hosts drop requests whose UA looks like a bare server.
        'User-Agent':
          'Mozilla/5.0 (compatible; PreciadoMosaic/1.0; +https://preciado-mosaic.vercel.app)',
        Accept: 'image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5',
      },
    });
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES_PER_IMAGE) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES_PER_IMAGE) return null;
    const type = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
    const b64 = buf.toString('base64');
    return `data:${type};base64,${b64}`;
  } catch {
    return null; // one dead link must never kill the whole batch
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  // Only GET.
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  // Allow the front end (same origin) and local `vite dev` (cz-proxy).
  res.setHeader('Access-Control-Allow-Origin', '*');

  const query = String(req.query.q ?? '').trim();
  const n = parseN(req.query.n);
  if (!query) {
    res.status(400).json({ ok: false, error: 'Missing query string ?q=…' });
    return;
  }

  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;

  if (!key || !cx) {
    res.status(503).json({
      ok: false,
      setup: true,
      error:
        'Google tile search is not configured. Set GOOGLE_CSE_KEY and GOOGLE_CSE_CX in the Vercel project settings to enable it — until then the demo library is used.',
    });
    return;
  }

  try {
    const urls = await gatherImageUrls(key, cx, query, n);
    if (!urls.length) {
      res.status(404).json({ ok: false, error: 'Google returned no images for that query.' });
      return;
    }

    // Fetch and encode a bounded subset; keep whatever decodes.
    const want = n;
    const dataUrls = [];
    // Don't hammer the whole batch at once.
    const chunk = urls.slice(0, want);
    for (const url of chunk) {
      const data = await proxyImage(url);
      if (data) dataUrls.push(data);
      if (dataUrls.length >= want) break;
    }

    if (!dataUrls.length) {
      res.status(502).json({ ok: false, error: 'Could not download any images from that search.' });
      return;
    }

    res.status(200).json({ ok: true, count: dataUrls.length, tiles: dataUrls });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
