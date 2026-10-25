/* Trip Weather service worker: app shell cache-first (revalidated), APIs network-only. */
const VERSION = 'tw-v2'; // bump on every release so installed PWAs re-fetch the shell
const SHELL = ['./', 'index.html', 'styles.css', 'lib.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const RUNTIME = 'tw-runtime-v1'; // Leaflet lib from unpkg only

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))) /* bypass HTTP cache */).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin app shell: serve from cache, refresh in background (stale-while-revalidate).
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) ||
        (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
      const net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => undefined);
      if (cached) { e.waitUntil(net); return cached; }
      const res = await net;
      return res || new Response('Offline', { status: 503, statusText: 'Offline' });
    })());
    return;
  }

  // Leaflet library (versioned, immutable): cache-first.
  if (url.hostname === 'unpkg.com' && url.pathname.startsWith('/leaflet@')) {
    e.respondWith(caches.open(RUNTIME).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // Everything else (APIs, map tiles): network only — no response caching.
});
