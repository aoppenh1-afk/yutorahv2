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

void test('search retries recover interrupted headers and bodies using the same request', async (t) => {
  const upstream = await fresh('interrupted-search');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    requests.push(input);
    if (requests.length === 1)
      throw new DOMException('The operation timed out.', 'TimeoutError');
    if (requests.length === 2)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              new TypeError('terminated', {
                cause: { code: 'UND_ERR_SOCKET' },
              }),
            );
          },
        }),
      );
    return Response.json({
      response: { numFound: 1, docs: [{ shiurid: 42 }] },
    });
  });
  const path = 'search/get?searchTerm=teshuva&teacherID=80153&start=4';
  const result = await upstream(path, 0);
  assert.equal(result.response.docs[0].shiurid, 42);
  assert.deepEqual(requests, Array(3).fill('https://yutorah.org/api/' + path));
});

void test('search retries stop after three interruptions and a later call can recover', async (t) => {
  const upstream = await fresh('exhausted-search');
  const failure = new DOMException('The operation timed out.', 'TimeoutError');
  let calls = 0;
  let failing = true;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (failing) throw failure;
    return Response.json({ response: { numFound: 0, docs: [] } });
  });
  const path = 'search/get?searchTerm=teshuva';
  const pending = await Promise.allSettled([upstream(path), upstream(path)]);
  assert.ok(
    pending.every((r) => r.status === 'rejected' && r.reason.cause === failure),
  );
  assert.equal(calls, 3);
  failing = false;
  assert.equal((await upstream(path)).response.numFound, 0);
  assert.equal(calls, 4);
});

void test('a timeout while consuming a search body also recovers', async (t) => {
  const upstream = await fresh('body-timeout');
  let calls = 0;
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) =>
    calls === 0
      ? AbortSignal.abort(new DOMException('Timed out.', 'TimeoutError'))
      : realTimeout(ms),
  );
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              new DOMException('The body was aborted.', 'AbortError'),
            );
          },
        }),
      );
    return Response.json({ response: { numFound: 0, docs: [] } });
  });
  assert.equal((await upstream('search/get?start=4', 0)).response.numFound, 0);
  assert.equal(calls, 2);
});

void test('search retries cannot extend the original eighteen-second deadline', async (t) => {
  const upstream = await fresh('deadline');
  let now = 0;
  let calls = 0;
  const timeouts = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(performance, 'now', () => now);
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return realTimeout(ms);
  });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    // Include time spent outside the request itself, such as a delayed event loop.
    now += calls === 1 ? 6000 : 12000;
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  await assert.rejects(upstream('search/get?start=4', 0), {
    name: 'SearchReadError',
  });
  assert.equal(calls, 2);
  assert.deepEqual(timeouts, [3000, 5000]);
});

void test('a slow final read can use the remaining deadline after two stalled connections', async (t) => {
  const upstream = await fresh('slow-final-read');
  let now = 0;
  let calls = 0;
  const budgets = new WeakMap();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(performance, 'now', () => now);
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    const signal = realTimeout(ms);
    budgets.set(signal, ms);
    return signal;
  });
  t.mock.method(globalThis, 'fetch', async (_input, { signal }) => {
    const latency = ++calls <= 2 ? Infinity : 7000;
    const budget = budgets.get(signal);
    now += Math.min(latency, budget);
    if (latency >= budget) throw new DOMException('Timed out.', 'TimeoutError');
    return Response.json({
      response: { numFound: 1, docs: [{ shiurid: 42 }] },
    });
  });
  assert.equal(
    (await upstream('search/get?start=4', 0)).response.docs[0].shiurid,
    42,
  );
  assert.equal(calls, 3);
  assert.ok(now <= 18000);
});

void test('temporary HTTP server errors recover through the same bounded search request', async (t) => {
  for (const status of [500, 502, 503, 504]) {
    await t.test(String(status), async (t) => {
      const upstream = await fresh('http-retry-' + status);
      const requests = [];
      t.mock.method(globalThis, 'fetch', async (input) => {
        requests.push(input);
        return requests.length === 1
          ? new Response('Unavailable', { status })
          : Response.json({
              response: { numFound: 1, docs: [{ shiurid: 42 }] },
            });
      });
      assert.equal(
        (await upstream('search/get?start=4', 0)).response.docs[0].shiurid,
        42,
      );
      assert.equal(requests.length, 2);
      assert.equal(requests[0], requests[1]);
    });
  }
});

void test('persistent server failures stay bounded and never become empty results', async (t) => {
  const upstream = await fresh('persistent-http');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('Unavailable', { status: 500 });
  });
  await assert.rejects(
    upstream('search/get?start=4', 0),
    (error) =>
      error.name === 'SearchReadError' &&
      /returned 500/.test(error.cause.message),
  );
  assert.equal(calls, 3);
});

void test('Retry-After seconds and dates count toward the deadline and longer waits stop automatic recovery', async (t) => {
  const upstream = await fresh('http-backoff');
  let now = 0;
  let calls = 0;
  const waits = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    waits.push(ms);
    now += ms;
    queueMicrotask(callback);
  });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1)
      return new Response('Unavailable', {
        status: 503,
        headers: { 'Retry-After': '1' },
      });
    if (calls === 2)
      return new Response('Unavailable', {
        status: 503,
        headers: { 'Retry-After': new Date(Date.now() + 20000).toUTCString() },
      });
    return Response.json({ response: { numFound: 0, docs: [] } });
  });
  await assert.rejects(upstream('search/get?start=4', 0), /returned 503/);
  assert.deepEqual(waits, [1000]);
  assert.equal(calls, 2);
  assert.ok(now < 18000);
});

void test('other HTTP errors and invalid JSON are not retried or replaced with empty search results', async (t) => {
  for (const { name, response, pattern } of [
    {
      name: 'http',
      response: new Response('Not found', { status: 404 }),
      pattern: /YUTorah returned 404/,
    },
    { name: 'json', response: new Response('{'), pattern: /JSON/ },
  ]) {
    await t.test(name, async (t) => {
      const upstream = await fresh('permanent-' + name);
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return response;
      });
      await assert.rejects(upstream('search/get?start=4', 0), pattern);
      assert.equal(calls, 1);
    });
  }
});

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
