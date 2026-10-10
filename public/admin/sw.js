// Service worker of the admin app: shows the "new order" notifications and opens the admin when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Нова поръчка', {
    body: d.body || '', tag: d.tag || undefined, renotify: Boolean(d.tag), icon: 'icon-192.png', badge: 'badge-96.png',
    data: { url: d.url || self.registration.scope + '#orders' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || self.registration.scope + '#orders', self.location.origin).href;
  // focus first (while the tap still allows it), then move the open admin to the order list; anything odd → a new window
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope)); // the admin (or the demo) this worker belongs to
    if (!open) return self.clients.openWindow(url);
    return open.focus().then((c) => (c || open).navigate(url)).catch(() => self.clients.openWindow(url));
  }));
});
