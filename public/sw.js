// Sonara service worker: the app works offline, and songs saved for offline
// play from the device. Saved songs live in the "sonara-offline" cache under
// /offline/track/<id>; everything else is cached as it's used.
const SHELL = 'sonara-shell-v6';
const API = 'sonara-api-v1';
const OFFLINE = 'sonara-offline';
const COVERS = 'sonara-covers-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/css/app.css', '/css/flat.css', '/js/app.js', '/favicon.svg', '/manifest.webmanifest']).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, API, OFFLINE, COVERS].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

/** Answer a Range request from a cached full response. */
async function ranged(req, res) {
  const range = req.headers.get('range');
  if (!range) return res;
  const buf = await res.arrayBuffer();
  const m = range.match(/bytes=(\d*)-(\d*)/);
  const size = buf.byteLength;
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) { start = size - Number(m[2]); end = size - 1; }
  end = Math.min(end, size - 1);
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' },
  });
}

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(cacheName)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;

  // Saved songs play from the device, even when online (faster, no data used).
  const stream = p.match(/^\/api\/stream\/(\d+)$/);
  if (stream) {
    e.respondWith((async () => {
      const hit = await caches.open(OFFLINE).then((c) => c.match(`/offline/track/${stream[1]}`));
      return hit ? ranged(req, hit) : fetch(req);
    })());
    return;
  }
  if (p.startsWith('/api/cover/')) {
    e.respondWith((async () => (await caches.match(req)) || networkFirst(req, COVERS))());
    return;
  }
  // Live data, downloads and anything sensitive: always from the network.
  // (Radio and podcast streams too: a live stream never ends, so it must not be cached.)
  if (p.startsWith('/api/stations/') || /^\/api\/podcasts\/episodes\/\d+\/stream$/.test(p) || p.startsWith('/api/podcasts/opml')) return;
  if (p.startsWith('/api/connect/') || p.startsWith('/api/download/') || p.startsWith('/api/admin/') || p.startsWith('/api/public/') || p.startsWith('/api/auth/oidc') || p === '/metrics') return;
  if (p.startsWith('/api/')) { e.respondWith(networkFirst(req, API)); return; }
  if (req.mode === 'navigate') {
    if (p.startsWith('/s/')) return;
    e.respondWith(fetch(req).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }
  // App files: use the cache right away, refresh it in the background.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  })());
});

// Signing out clears cached library data (but keeps saved songs unless asked).
self.addEventListener('message', (e) => {
  if (e.data === 'clear-api') caches.delete(API);
  if (e.data === 'clear-all') for (const k of [API, OFFLINE, COVERS]) caches.delete(k);
});
