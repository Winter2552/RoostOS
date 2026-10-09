'use strict';

// Roost's service worker. It only steps in for page loads: pages always come
// fresh from the server, and when the server can't be reached the cached
// offline screen shows instead of the browser's error. API calls, files and
// everything else go straight to the network untouched.

const CACHE = 'roost-offline-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Start the page request while the worker wakes, so it adds no delay.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith((async () => {
    try {
      return (await event.preloadResponse) || (await fetch(event.request));
    } catch {
      return (await caches.match(OFFLINE)) || Response.error();
    }
  })());
});
