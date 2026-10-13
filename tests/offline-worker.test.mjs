import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(
  new URL('../public/sw.js', import.meta.url),
  'utf8',
);
const origin = 'https://yutorah.test';
function worker() {
  const events = {},
    stores = new Map();
  const key = (value) =>
    new URL(typeof value === 'string' ? value : value.url, origin).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async put(request, response) {
          store.set(key(request), response.clone());
        },
        async match(request) {
          return store.get(key(request))?.clone();
        },
        async addAll(requests) {
          for (const request of requests)
            store.set(key(request), new Response('asset'));
        },
        async delete(request) {
          return store.delete(key(request));
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
  };
  const self = {
    __YUTORAH_SHELL__: { version: 'test', assets: ['/_next/test.js'] },
    location: { origin },
    clients: { async claim() {} },
    skipWaiting() {},
    addEventListener(type, callback) {
      events[type] = callback;
    },
  };
  const context = vm.createContext({
    self,
    caches,
    Request: class extends Request {
      constructor(url, init) {
        super(new URL(url, origin), init);
      }
    },
    Response,
    URL,
    TextDecoder,
    fetch: async () => {
      throw new Error('offline');
    },
    console,
  });
  vm.runInContext(source, context);
  return { context, caches, events, stores };
}
void test('offline navigation returns the cached app at arbitrary root query URLs', async () => {
  const w = worker();
  const cache = await w.caches.open('yutorah-shell-test');
  await cache.put(
    '/',
    new Response('<html><head></head><body>App</body></html>'),
  );
  const response = await w.context.offlineNavigation(
    new Request(origin + '/?view=search&q=shabbat'),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /window.__YUTORAH_OFFLINE__=true/);
});
void test('cached audio handles seeking, open-ended ranges, suffixes and invalid requests', async () => {
  const w = worker();
  const cache = await w.caches.open('yutorah-audio-v1');
  await cache.put(
    '/offline-audio/1',
    new Response('0123456789', {
      headers: { 'Content-Type': 'audio/mpeg', 'X-YUTorah-Complete': '10' },
    }),
  );
  for (const [range, body, contentRange] of [
    ['bytes=2-4', '234', 'bytes 2-4/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=0-99', '0123456789', 'bytes 0-9/10'],
  ]) {
    const response = await w.context.cachedAudio(
      new Request(origin + '/offline-audio/1', { headers: { Range: range } }),
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(await response.text(), body);
  }
  for (const range of [
    'bytes=12-',
    'bytes=4-2',
    'bytes=0-1,3-4',
    'bytes=-0',
    'garbage',
  ])
    assert.equal(
      (
        await w.context.cachedAudio(
          new Request(origin + '/offline-audio/1', {
            headers: { Range: range },
          }),
        )
      ).status,
      416,
    );
  assert.equal(
    (await w.context.cachedAudio(new Request(origin + '/offline-audio/2')))
      .status,
    404,
  );
});
void test('the shell is ready only after all static assets and the public root are cached', async () => {
  const w = worker();
  w.context.fetch = async () =>
    new Response('<html><head></head></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
  await w.context.prepareOffline();
  const cache = await w.caches.open('yutorah-shell-test');
  assert.ok(await cache.match('/offline-shell-ready'));
  assert.ok(await cache.match('/_next/test.js'));
  assert.ok(await cache.match('/'));
});
void test('API and account requests are never intercepted or cached', () => {
  const w = worker();
  for (const path of [
    '/api/connection',
    '/api/audio-download?id=1',
    '/api/home',
    '/auth/callback',
    '/privacy',
  ]) {
    let intercepted = false;
    w.events.fetch({
      request: new Request(origin + path),
      respondWith() {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false, path);
  }
});
void test('saved cross-origin portraits load without network traffic', async () => {
  const w = worker();
  const url =
    'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/rebbe_lp.jpg';
  await (
    await w.caches.open('yutorah-portraits-v1')
  ).put(
    url,
    new Response('portrait', { headers: { 'Content-Type': 'image/jpeg' } }),
  );
  const request = new Request(url);
  Object.defineProperty(request, 'destination', { value: 'image' });
  let response = Promise.resolve(new Response(null, { status: 500 }));
  w.events.fetch({
    request,
    respondWith(value) {
      response = value;
    },
  });
  assert.equal(await (await response).text(), 'portrait');
});
