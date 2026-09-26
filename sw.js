// INKWAVE service worker: makes the PWA start instantly and play offline.
//   · code (index, src/, styles/, manifest) → network first, cached copy when offline — an update is live on the next launch
//   · assets/ and vendor/ (textures, fonts, lightmaps, three.js) → served from cache at once, refreshed in the background
const CACHE = 'inkwave-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes('/tools/')) return;
  const rel = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  const stable = rel.startsWith('assets/') || rel.startsWith('vendor/');
  e.respondWith(stable ? staleWhileRevalidate(e, req) : networkFirst(req));
});

async function put(req, res) {
  if (res && res.ok && res.type === 'basic') { const c = await caches.open(CACHE); await c.put(req, res.clone()); }
  return res;
}

async function networkFirst(req) {
  try { return await put(req, await fetch(req)); }
  catch (err) {
    const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(e, req) {
  const hit = await caches.match(req);
  const net = fetch(req).then((res) => put(req, res)).catch(() => null);
  if (hit) { e.waitUntil(net); return hit; }
  return (await net) || Response.error();
}
