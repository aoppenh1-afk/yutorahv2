import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createShiurViewsReader } from '../lib/shiur-views';
import { viewCount, viewCountLabel } from '../lib/view-count';
import { normalize } from '../lib/yutorah';
import { ShiurViews } from '../app/shiur-views';
import { GET as viewsRoute } from '../app/api/shiur-views/route';
import { GET as detailRoute } from '../app/api/shiur/route';

const requestUrl = (input: string | URL | Request) =>
  new URL(input instanceof Request ? input.url : input);

void test('public counters preserve zero and reject missing or invalid values', () => {
  for (const count of [0, 1, 12500]) {
    assert.equal(viewCount(count), count);
    assert.equal(viewCount(String(count)), count);
    assert.equal(
      normalize({ shiurid: 42, shiurvisitsnum: String(count) }).views,
      count,
    );
  }
  for (const count of [
    undefined,
    null,
    '',
    'unknown',
    -1,
    1.5,
    Infinity,
    NaN,
    true,
    [],
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(viewCount(count), undefined);
  assert.equal(viewCountLabel(1), '1 view');
  assert.equal(viewCountLabel(12500), '12,500 views');
  const markup = renderToStaticMarkup(
    <ShiurViews shiur={{ id: 42, views: 0 }} />,
  );
  assert.match(markup, /0 views/);
  assert.match(markup, /Total views on YUTorah/);
  assert.match(
    renderToStaticMarkup(<ShiurViews shiur={{ id: 42, views: 1 }} />),
    /1 view</,
  );
  for (const views of [undefined, -1, Infinity])
    assert.doesNotMatch(
      renderToStaticMarkup(<ShiurViews shiur={{ id: 42, views }} />),
      /\d+ views|Total views/,
    );
});

void test('numeric lookup matches the ID, coalesces requests, caches zero, and cancels unused facets', async (t) => {
  const calls: string[] = [];
  let canceled = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = requestUrl(input);
    calls.push(url.href);
    const id = Number(url.searchParams.get('searchTerm'));
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                response: {
                  docs: [
                    { shiurid: 999, shiurvisitsnum: 900 },
                    { shiurid: id, shiurvisitsnum: id === 42 ? 0 : '1234' },
                  ],
                  numFound: 2,
                  start: 1,
                },
              }).slice(0, -1) + ',"facet_counts":',
            ),
          );
        },
        cancel() {
          canceled++;
        },
      }),
    );
  });
  const read = createShiurViewsReader();
  assert.deepEqual(await Promise.all([read([42, 43, 42]), read([42])]), [
    { 42: 0, 43: 1234 },
    { 42: 0 },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(canceled, 2);
  assert.ok(
    calls.every((url) => url.startsWith('https://api.yutorah.org/search/get?')),
  );
  assert.deepEqual(await read([42, 43]), { 42: 0, 43: 1234 });
  assert.equal(calls.length, 2);
});

void test('missing results and outages never fabricate zero, and failed requests can recover', async (t) => {
  let failing = true;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const id = Number(requestUrl(input).searchParams.get('searchTerm'));
    if (id === 42 && failing) throw new Error('upstream unavailable');
    return Response.json({
      response: {
        docs: [{ shiurid: id === 43 ? 999 : id, shiurvisitsnum: 12 }],
      },
    });
  });
  const read = createShiurViewsReader();
  assert.deepEqual(await read([42, 43, 0, -1]), {});
  failing = false;
  assert.deepEqual(await read([42]), { 42: 12 });
});

void test('upstream concurrency stays bounded across simultaneous batches', async (t) => {
  let active = 0,
    maximum = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    const id = Number(requestUrl(input).searchParams.get('searchTerm'));
    return Response.json({
      response: { docs: [{ shiurid: id, shiurvisitsnum: 10 }] },
    });
  });
  const read = createShiurViewsReader();
  const results = await Promise.all([
    read(Array.from({ length: 24 }, (_, i) => i + 1)),
    read([25, 26, 27]),
  ]);
  assert.equal(maximum, 6);
  assert.equal(Object.keys(results[0]).length, 24);
  assert.equal(Object.keys(results[1]).length, 3);
});

void test('successful counters refresh after five minutes', async (t) => {
  let now = 0,
    calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      response: { docs: [{ shiurid: 42, shiurvisitsnum: ++calls }] },
    }),
  );
  const read = createShiurViewsReader();
  assert.deepEqual(await read([42]), { 42: 1 });
  now = 299999;
  assert.deepEqual(await read([42]), { 42: 1 });
  now = 300000;
  assert.deepEqual(await read([42]), { 42: 2 });
});

void test('counter failures leave shiur details available without inventing a count', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (requestUrl(input).pathname.endsWith('/shiur/details'))
      return Response.json({
        shiurID: 234567,
        shiurTitle: 'A playable shiur',
        shiurFileURL: 'https://example.test/shiur.mp3',
      });
    return new Response('Unavailable', { status: 503 });
  });
  const response = await detailRoute(
    new Request('https://example.test/api/shiur?id=234567'),
  );
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.audio, 'https://example.test/shiur.mp3');
  assert.equal(detail.views, undefined);
});

void test('batch route validates IDs and detail links include the official count', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.pathname.endsWith('/shiur/details'))
      return Response.json({ shiurID: 123456, shiurTitle: 'A shiur' });
    const id = Number(url.searchParams.get('searchTerm'));
    return Response.json({
      response: { docs: [{ shiurid: id, shiurvisitsnum: 1234 }] },
    });
  });
  for (const ids of [
    '',
    '0',
    '-1',
    '42,abc',
    '1.5',
    '1000000000',
    Array(25).fill('42').join(','),
  ])
    assert.equal(
      (
        await viewsRoute(
          new Request('https://example.test/api/shiur-views?ids=' + ids),
        )
      ).status,
      400,
    );
  const response = await viewsRoute(
    new Request('https://example.test/api/shiur-views?ids=123456,123457'),
  );
  assert.deepEqual(await response.json(), {
    views: { 123456: 1234, 123457: 1234 },
  });
  const detail = await detailRoute(
    new Request('https://example.test/api/shiur?id=123456'),
  );
  assert.equal((await detail.json()).views, 1234);
});
