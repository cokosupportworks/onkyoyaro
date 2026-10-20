// HTML/CSS/JS updates are fetched online; cached files remain available offline.
const CACHE_NAME = 'onkyoyaro-v43-network-first';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './jszip.min.js',
  './manifest.json', './onkyologo.png', './apple-touch-icon.png'
];
const APP_URLS = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
const INDEX_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Bypass old HTTP cache when installing the new offline snapshot.
    await cache.addAll(ASSETS.map(path => new Request(
      new URL(path, self.registration.scope).href, { cache: 'reload' }
    )));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('onkyoyaro-') && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  url.hash = '';
  if (!APP_URLS.has(url.href)) return;

  // Keep the cache write alive even after the response has been delivered.
  let finishWrite;
  const writeFinished = new Promise(resolve => { finishWrite = resolve; });
  event.waitUntil(writeFinished);
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { cache: 'no-cache' });
      if (response.ok) {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(url.href, response.clone());
          if (event.request.mode === 'navigate') {
            await cache.put(INDEX_URL, response.clone());
          }
        } catch (error) {
          // A full/unavailable cache must not block a successful online response.
          console.warn('Offline cache update failed:', error);
        }
      }
      return response;
    } catch {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url.href);
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const index = await cache.match(INDEX_URL);
        if (index) return index;
      }
      return Response.error();
    } finally {
      finishWrite();
    }
  })());
});
