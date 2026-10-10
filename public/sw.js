'use strict';

// Roost's service worker. It only steps in for page loads: pages always come
// fresh from the server, and when the server can't be reached the cached
// offline screen shows instead of the browser's error. API calls, files and
// everything else go straight to the network untouched. It also shows phone
// alerts when Roost sends one (see src/push.js) and opens Roost when tapped.

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

// A phone alert. Every push has to show something, and a later alert with the
// same tag replaces the earlier one, so "Jellyfin is back" takes the place of
// "Jellyfin has stopped".
self.addEventListener('push', (event) => {
  let m = {};
  try {
    m = event.data ? event.data.json() : {};
  } catch {
    m = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(m.title || 'Roost', {
    body: m.body || '',
    tag: m.tag,
    icon: '/icons/icon-192.png',
    data: { url: typeof m.url === 'string' && m.url.startsWith('/') ? m.url : '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data || {}).url || '/';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (!win) return self.clients.openWindow(url);
    await win.focus();
    // Same page, new hash: no reload, the app just moves to the status view.
    return win.navigate(url).catch(() => {});
  })());
});
