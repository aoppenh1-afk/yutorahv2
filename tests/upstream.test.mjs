import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['lib/yutorah.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const moduleURL =
  'data:text/javascript;base64,' +
  Buffer.from(compiled.outputFiles[0].text).toString('base64');
const fresh = async (name) => (await import(moduleURL + '#' + name)).upstream;

void test('concurrent cached requests share one fetch and subsequent reads use the cache', async (t) => {
  const upstream = await fresh('concurrent');
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    await gate;
    return Response.json({ value: calls });
  });
  const requests = Array.from({ length: 10 }, () =>
    upstream('homepage/details'),
  );
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all(requests), Array(10).fill({ value: 1 }));
  assert.deepEqual(await upstream('homepage/details'), { value: 1 });
  assert.equal(calls, 1);
});

void test('failed shared requests are cleared so a retry can succeed', async (t) => {
  const upstream = await fresh('retry');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 503 }) : Response.json([]);
  });
  const responses = await Promise.allSettled([
    upstream('browse/teachers'),
    upstream('browse/teachers'),
  ]);
  assert.ok(responses.every((r) => r.status === 'rejected'));
  assert.equal(calls, 1);
  assert.deepEqual(await upstream('browse/teachers'), []);
  assert.equal(calls, 2);
});

void test('expired cached responses refresh once for concurrent readers', async (t) => {
  const upstream = await fresh('expiry');
  let now = 1000;
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => Response.json(++calls));
  assert.equal(await upstream('browse/series', 1), 1);
  now = 2001;
  assert.deepEqual(
    await Promise.all([
      upstream('browse/series', 1),
      upstream('browse/series', 1),
    ]),
    [2, 2],
  );
  assert.equal(calls, 2);
});

void test('fresh search scans bypass cached and in-flight requests without replacing the cache', async (t) => {
  const upstream = await fresh('fresh');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ response: ++calls }),
  );
  const path = 'search/get?searchTerm=teshuva';
  assert.equal((await upstream(path)).response, 1);
  assert.deepEqual(
    (await Promise.all([upstream(path, 0), upstream(path, 0)])).map(
      (r) => r.response,
    ),
    [2, 3],
  );
  assert.equal((await upstream(path)).response, 1);
  assert.equal(calls, 3);
});

void test('uncached scan pages do not evict reusable directory responses', async (t) => {
  const upstream = await fresh('eviction');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++calls));
  await upstream('browse/teachers', 3600);
  for (let page = 1; page <= 40; page++)
    await upstream('search/get?start=' + page, 0);
  assert.equal(await upstream('browse/teachers', 3600), 1);
  assert.equal(calls, 41);
});

void test('cached responses remain bounded', async (t) => {
  const upstream = await fresh('bound');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++calls));
  for (let id = 0; id < 37; id++) await upstream('shiur/details?shiurID=' + id);
  assert.equal(await upstream('shiur/details?shiurID=36'), 37);
  assert.equal(await upstream('shiur/details?shiurID=0'), 38);
});
