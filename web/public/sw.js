/* Optional offline support. The whole app is static and does its maths in
 * the browser, so once the shell and the tile atlas are cached it works with
 * no network at all (only "Pull from Google" needs one).
 *
 * - /assets/* and /tiles/* are content-hashed or immutable: cache-first.
 * - Navigations: network-first, falling back to the cached shell.
 * - /api/* is never touched. */
const CACHE = 'preciado-mosaic-v1';
const SHELL = ['/', '/favicon.svg', '/manifest.webmanifest', '/tiles/atlas.json', '/tiles/atlas.webp', '/demo/demo_sunset.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && /^\/(assets|tiles|demo)\//.test(url.pathname)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
