const CACHE = 'reword-v18';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Receive a background push and show it as a lock-screen notification
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'Your turn in Reword!', {
      body:      data.body  || 'Your opponent has played. Your move!',
      icon:      data.icon  || '/icon-192.png',
      badge:     data.badge || '/icon-192.png',
      tag:       `reword-turn-${data.gameId || 'game'}`,
      renotify:  true,
      data:      { gameId: data.gameId, recipientRole: data.recipientRole }
    })
  );
});

// Bring app to foreground and load the right game when user taps a turn notification
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const gameId = e.notification.data?.gameId;
  const myRole = e.notification.data?.myRole || e.notification.data?.recipientRole;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length) {
        const client = clients[0];
        client.focus();
        if (gameId) client.postMessage({ type: 'load-game', gameId, myRole });
        return;
      }
      return self.clients.openWindow('/');
    })
  );
});

// Network-first: always try the network, fall back to cache
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
