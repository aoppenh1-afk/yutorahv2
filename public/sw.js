/* No offline caching: media and account responses stay with the website. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* Always show a visible notification. */ }
  const id = /^shiur-(\d+)$/.exec(String(payload.tag ?? ''))?.[1];
  const url = id ? '/?shiur=' + id : '/?view=following';
  event.waitUntil(self.registration.showNotification(
    typeof payload.title === 'string' ? payload.title.slice(0, 150) : 'New shiur on YUTorah',
    { body: typeof payload.body === 'string' ? payload.body.slice(0, 300) : 'Open YUTorah to continue learning.',
      icon: '/icons/yutorah-192.png', badge: '/icons/yutorah-192.png',
      tag: id ? 'shiur-' + id : 'yutorah-test', data: { url } },
  ));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const raw = event.notification.data?.url;
  const path = typeof raw === 'string' && /^\/\?(shiur=\d+|view=following)$/.test(raw) ? raw : '/?view=following';
  const destination = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if (new URL(client.url).origin === self.location.origin) {
      await client.navigate(destination); return client.focus();
    }
    return self.clients.openWindow(destination);
  })());
});
