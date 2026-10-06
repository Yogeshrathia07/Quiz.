/**
 * Keeps the app openable through a bad connection, and quick to open.
 *
 *  - Vite's hashed files under /assets/ never change for a given URL, so they
 *    are served from the cache and fetched once. The app fetches the other
 *    screens' files ahead in quiet moments (lib/prefetch.js), so they are
 *    here before they are needed.
 *  - Portal pages (results, the quiz list, a dashboard…) open from the saved
 *    page at once and fetch it fresh behind, for next time: the page is the
 *    same for every address, and waiting on the network for it cost a whole
 *    round trip on every open. A newer version is noticed by the app itself
 *    (useAppUpdate.js), which offers Update.
 *  - A test or a register (?test=, ?attend=), and a reload someone asked for,
 *    are fetched fresh when possible - a paper should always run the newest
 *    version - and served from the cache when the network is gone, so
 *    reloading mid-test still opens the test.
 *
 * The API is never cached. An answer, a deadline or a registration must always
 * come from the server, and a stale one would be worse than an error. Unsent
 * answers are held by the app itself, in this device's storage.
 */
// Bump this whenever the client shell changes. This makes an installed copy of
// the app discard the prior shell instead of leaving people on old CSS.
const CACHE = 'quiz-shell-v3';
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

/** The page from the network, kept for next time when it came. */
const freshShell = (request) => fetch(request).then((response) => {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(SHELL, copy)).catch(() => undefined);
  }
  return response;
});

/** A paper, a register, or a reload someone asked for: the newest page first. */
const wantsFresh = (url, request) => url.searchParams.has('test') || url.searchParams.has('attend')
  || request.cache === 'reload' || request.cache === 'no-cache' || request.cache === 'no-store';

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

  if (request.mode !== 'navigate') return;
  if (wantsFresh(url, request)) {
    event.respondWith(freshShell(request).catch(() => caches.match(SHELL).then((hit) => hit || Response.error())));
    return;
  }
  // Opened from the saved page at once; the fresh one is fetched behind it.
  event.respondWith(caches.match(SHELL).then((hit) => {
    const fresh = freshShell(request);
    if (!hit) return fresh.catch(() => Response.error());
    event.waitUntil(fresh.catch(() => undefined));
    return hit;
  }));
});

// The app's Update button (and a screen whose file is gone after an update):
// the saved page replaced by the newest before the reload that opens it.
self.addEventListener('message', (event) => {
  if (event.data !== 'refresh-shell') return;
  event.waitUntil(
    fetch(SHELL, { cache: 'no-store' })
      .then((response) => (response.ok ? caches.open(CACHE).then((cache) => cache.put(SHELL, response)) : undefined))
      .catch(() => undefined)
      .then(() => event.source?.postMessage('shell-refreshed'))
  );
});
