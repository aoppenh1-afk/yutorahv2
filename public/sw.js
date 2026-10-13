/* The generated build prepends the exact shell version and client asset list. */
const shell = self.__YUTORAH_SHELL__;
const SHELL_CACHE = 'yutorah-shell-' + (shell?.version || 'development');
const AUDIO_CACHE = 'yutorah-audio-v1';
const PORTRAIT_CACHE = 'yutorah-portraits-v1';
const READY = '/offline-shell-ready';
let preparing;
async function prepareOffline() {
  if (!shell?.assets?.length)
    throw new Error(
      'The app could not be prepared for offline use. Try again.',
    );
  const cache = await caches.open(SHELL_CACHE);
  if (await cache.match(READY)) return;
  if (preparing) return preparing;
  preparing = (async () => {
    // Only the public shell is cached. Account responses and API data never enter this cache.
    const response = await fetch('/', { cache: 'reload', credentials: 'omit' });
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('text/html')
    )
      throw new Error('Could not save the app for offline use.');
    await cache.addAll(
      shell.assets.map(
        (url) => new Request(url, { cache: 'reload', credentials: 'omit' }),
      ),
    );
    await cache.put('/', response);
    await cache.put(READY, new Response(shell.version));
  })().finally(() => {
    preparing = undefined;
  });
  return preparing;
}
self.addEventListener('install', (event) => {
  if (shell) event.waitUntil(prepareOffline().then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      // Do not delete older shell caches under an open tab. Its hashed chunks may still be in use.
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener('message', (event) => {
  if (event.data?.type === 'PREPARE_OFFLINE')
    event.waitUntil(
      prepareOffline().then(
        () => event.ports[0]?.postMessage({ ready: true }),
        (error) =>
          event.ports[0]?.postMessage({ ready: false, error: error.message }),
      ),
    );
});
async function cachedAsset(request) {
  const current = await (await caches.open(SHELL_CACHE)).match(request);
  if (current) return current;
  for (const name of await caches.keys()) {
    if (name.startsWith('yutorah-shell-') && name !== SHELL_CACHE) {
      const response = await (await caches.open(name)).match(request);
      if (response) return response;
    }
  }
  return fetch(request);
}
async function offlineNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const root = await cache.match('/');
    if (!root)
      return new Response(
        'No internet connection. Reconnect once to prepare your downloads.',
        {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        },
      );
    const html = (await root.text()).replace(
      '</head>',
      '<script>window.__YUTORAH_OFFLINE__=true;</script></head>',
    );
    // Serve the shell at the requested URL. React immediately opens Downloads, without a network redirect.
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}
async function cachedAudio(request) {
  const url = new URL(request.url);
  const response = await (await caches.open(AUDIO_CACHE)).match(url.pathname);
  if (!response || !response.headers.has('X-YUTorah-Complete'))
    return new Response('This download is no longer on this device.', {
      status: 404,
    });
  const range = request.headers.get('range');
  if (!range) return response;
  const blob = await response.blob();
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0,
    end = blob.size - 1;
  if (match && (match[1] || match[2])) {
    if (!match[1]) start = Math.max(0, blob.size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
  } else start = blob.size;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= blob.size ||
    end < start
  )
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + blob.size },
    });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': response.headers.get('content-type') || 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + blob.size,
      'Content-Length': String(end - start + 1),
    },
  });
}
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (
    request.destination === 'image' &&
    !(
      url.origin === self.location.origin &&
      shell?.assets?.includes(url.pathname)
    )
  ) {
    // Only images explicitly saved by a download enter this cache. Reuse their
    // readable bytes for normal image URLs, including the cross-origin CDN.
    event.respondWith(
      (async () => {
        const hit = await (await caches.open(PORTRAIT_CACHE)).match(request);
        return hit || fetch(request);
      })(),
    );
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (/^\/offline-audio\/[1-9]\d{0,8}$/.test(url.pathname)) {
    event.respondWith(cachedAudio(request));
    return;
  }
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(offlineNavigation(request));
    return;
  }
  if (
    url.pathname.startsWith('/_next/') ||
    shell?.assets?.includes(url.pathname)
  )
    event.respondWith(cachedAsset(request));
});
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    /* Always show a visible notification. */
  }
  const id = /^shiur-(\d+)$/.exec(String(payload.tag ?? ''))?.[1];
  const url = id ? '/?shiur=' + id : '/?view=following';
  event.waitUntil(
    self.registration.showNotification(
      typeof payload.title === 'string'
        ? payload.title.slice(0, 150)
        : 'New shiur on YUTorah',
      {
        body:
          typeof payload.body === 'string'
            ? payload.body.slice(0, 300)
            : 'Open YUTorah to continue learning.',
        icon: '/icons/yutorah-192.png',
        badge: '/icons/yutorah-192.png',
        tag: id ? 'shiur-' + id : 'yutorah-test',
        data: { url },
      },
    ),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data?.url;
  const path =
    typeof raw === 'string' && /^\/\?(shiur=\d+|view=following)$/.test(raw)
      ? raw
      : '/?view=following';
  const destination = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windows)
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(destination);
          return client.focus();
        }
      return self.clients.openWindow(destination);
    })(),
  );
});
