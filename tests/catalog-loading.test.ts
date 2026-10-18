import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cachedCatalogResource,
  invalidateCatalogResource,
  loadCatalogResource,
  prefetchCatalogDirectories,
} from '../lib/catalog-client';

void test('query-free public requests preserve the exact preload URL and share its cache key', async (t) => {
  invalidateCatalogResource('/api/home');
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(url);
    return Response.json({ featured: [] });
  });
  await loadCatalogResource('/api/home');
  await loadCatalogResource('/api/home?');
  assert.deepEqual(urls, ['/api/home']);
});

void test('revisiting a catalog page and its covers does not repeat the loading waterfall', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requests.push(url);
    return Response.json(
      url.includes('artwork')
        ? { image: 'https://images.example.test/cover.jpg' }
        : { entries: [{ id: 6536 }], total: 1, next: null },
    );
  });
  for (const url of [
    '/api/catalog?kind=collection&q=&offset=0',
    '/api/catalog?kind=venue&q=&offset=0',
    '/api/catalog-artwork?id=6536&format=json',
  ]) {
    await loadCatalogResource(url);
    await loadCatalogResource(url);
  }
  assert.equal(
    requests.length,
    3,
    'Returning to two directories and a visible cover should reuse their successful responses',
  );
});
void test('duplicate collection covers share an in-flight metadata lookup', async (t) => {
  let calls = 0;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    await ready;
    return Response.json({ image: '' });
  });
  const url = '/api/catalog-artwork?id=8685&format=json';
  const first = loadCatalogResource(url);
  const second = loadCatalogResource(url);
  finish();
  await Promise.all([first, second]);
  assert.equal(
    calls,
    1,
    'Concurrent instances should share a request, including empty artwork',
  );
  assert.deepEqual(cachedCatalogResource(url), { image: '' });
});
void test('expired pages refresh while cover URLs remain cached, and explicit retry refreshes', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return Response.json({ image: '', entries: [] });
  });
  const page = '/api/catalog?kind=collection&q=expiration&offset=0';
  const cover = '/api/catalog-artwork?id=99761&format=json';
  await loadCatalogResource(page);
  await loadCatalogResource(cover);
  now += 60_001;
  assert.notEqual(
    cachedCatalogResource(page),
    undefined,
    'The last successful page remains visible during refresh',
  );
  assert.notEqual(cachedCatalogResource(cover), undefined);
  await loadCatalogResource(page);
  invalidateCatalogResource(cover);
  await loadCatalogResource(cover);
  assert.equal(calls.length, 4);
});
void test('failed and unavailable responses can be retried and account requests are excluded', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1)
      return Response.json({ error: 'Upstream timed out' }, { status: 502 });
    if (calls === 2) return Response.json({ unavailable: 'Try again' });
    return Response.json({ entries: [] });
  });
  const url = '/api/catalog?kind=venue&q=retry&offset=0';
  await assert.rejects(loadCatalogResource(url), /Upstream timed out/);
  await loadCatalogResource(url);
  assert.equal(cachedCatalogResource(url), undefined);
  await loadCatalogResource(url);
  assert.equal(calls, 3);
  assert.throws(
    () => loadCatalogResource('/api/account-library'),
    /Only public catalog/,
  );
});
void test('Browse preloading and a tab click share canonical directory requests', async (t) => {
  const calls: string[] = [];
  const collection = '/api/catalog?kind=collection&q=&offset=0';
  const venue = '/api/catalog?kind=venue&q=&offset=0';
  invalidateCatalogResource(collection);
  invalidateCatalogResource(venue);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return Response.json({ entries: [], total: 0, next: null });
  });
  prefetchCatalogDirectories();
  await Promise.all([
    loadCatalogResource(collection),
    loadCatalogResource('/api/catalog?offset=0&q=&kind=venue'),
  ]);
  assert.equal(calls.length, 2);
  assert.notEqual(cachedCatalogResource(venue), undefined);
});
void test('public response retention stays bounded as a user visits more pages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ entries: [] }),
  );
  const url = (n: number) =>
    '/api/catalog?kind=collection&q=bounded-' + n + '&offset=0';
  for (let n = 0; n < 65; n++) await loadCatalogResource(url(n));
  assert.equal(cachedCatalogResource(url(0)), undefined);
  assert.notEqual(cachedCatalogResource(url(64)), undefined);
});

void test('aborting one catalog subscriber leaves another reader and its shared cache request intact', async (t) => {
  const controller = new AbortController();
  let finish!: (response: Response) => void;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    return new Promise<Response>((r) => {
      finish = r;
    });
  });
  const url = '/api/catalog?kind=collection&q=cancel-shared&offset=0';
  const canceled = loadCatalogResource(url, controller.signal);
  const other = loadCatalogResource<{ entries: number[] }>(url);
  controller.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  finish(Response.json({ entries: [1, 2] }));
  assert.deepEqual(await other, { entries: [1, 2] });
  assert.equal(calls, 1);
  assert.deepEqual(cachedCatalogResource(url), { entries: [1, 2] });
});

void test('explicit retry cannot be overwritten by an older in-flight response', async (t) => {
  const finish: ((response: Response) => void)[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    () => new Promise<Response>((r) => finish.push(r)),
  );
  const url = '/api/catalog?kind=collection&q=invalidation-order&offset=0';
  const old = loadCatalogResource(url);
  invalidateCatalogResource(url);
  const fresh = loadCatalogResource(url);
  finish[1](Response.json({ entries: ['fresh'] }));
  await fresh;
  finish[0](Response.json({ entries: ['old'] }));
  await old;
  assert.deepEqual(cachedCatalogResource(url), { entries: ['fresh'] });
});

void test('a failed background refresh keeps the last successful page available', async (t) => {
  let now = Date.now(),
    calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? Response.json({ entries: [42] })
      : Response.json({ error: 'Unavailable' }, { status: 502 }),
  );
  const url = '/api/catalog?kind=collection&q=stale-outage&offset=0';
  await loadCatalogResource(url);
  now += 61_000;
  assert.deepEqual(cachedCatalogResource(url), { entries: [42] });
  assert.deepEqual(await loadCatalogResource(url), { entries: [42] });
  assert.equal(calls, 2);
});
