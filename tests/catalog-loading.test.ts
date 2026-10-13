import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cachedCatalogResource,
  invalidateCatalogResource,
  loadCatalogResource,
  prefetchCatalogDirectories,
} from '../lib/catalog-client';

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
  assert.equal(cachedCatalogResource(page), undefined);
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
