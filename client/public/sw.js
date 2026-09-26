/**
 * Keeps the app openable through a bad connection.
 *
 * Two rules, deliberately narrow:
 *  - Vite's hashed files under /assets/ never change for a given URL, so they
 *    are served from the cache and fetched once.
 *  - The page itself is fetched fresh when possible and served from the cache
 *    when the network is gone, so reloading mid-test still opens the test.
 *
 * The API is never cached. An answer, a deadline or a registration must always
 * come from the server, and a stale one would be worse than an error. Unsent
 * answers are held by the app itself, in this device's storage.
 */
// Bump this whenever the client shell changes. This makes an installed copy of
// the app discard the prior shell instead of leaving people on old CSS.
const CACHE = 'quiz-shell-v2';
const SHELL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

const isAsset = (url) => url.pathname.startsWith('/assets/');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Everything the test depends on for correctness stays online-only.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  if (isAsset(url)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      }))
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(SHELL, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit || Response.error()))
    );
  }
});
