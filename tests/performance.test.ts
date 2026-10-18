import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/performance/route';
void test('performance telemetry accepts only bounded aggregate numbers and device/cache segments', async (t) => {
  const messages: string[] = [];
  t.mock.method(console, 'log', (message: string) => messages.push(message));
  const metrics = {
    LCP: 2400,
    INP: 150,
    CLS: 0.08,
    longTasks: 2,
    longTaskMs: 140,
    viewCommits: 4,
    viewCommitMs: 12,
    maxVisibleRows: 160,
    libraryWrites: 3,
    libraryWriteMs: 6,
  };
  const send = (body: unknown) =>
    POST(
      new Request('https://example.test/api/performance', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  assert.equal(
    (await send({ device: 'mobile', cache: 'cold', metrics })).status,
    204,
  );
  assert.deepEqual(JSON.parse(messages[0]), {
    event: 'frontend_performance',
    version: 1,
    device: 'mobile',
    navigationCache: 'cold',
    metrics,
  });
  for (const body of [
    { device: 'tablet', cache: 'cold', metrics },
    { device: 'desktop', cache: 'private-url', metrics },
    { device: 'desktop', cache: 'warm', metrics: { query: 'private query' } },
    { device: 'desktop', cache: 'warm', metrics: { LCP: -1 } },
    { device: 'desktop', cache: 'warm', metrics: { LCP: 1e9 } },
  ])
    assert.equal((await send(body)).status, 400);
  assert.equal(
    (
      await POST(
        new Request('https://example.test/api/performance', {
          method: 'POST',
          body: 'x'.repeat(2049),
        }),
      )
    ).status,
    413,
  );
  let canceled = false;
  assert.equal(
    (
      await POST(
        new Request('https://example.test/api/performance', {
          method: 'POST',
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('ש'.repeat(1025)));
            },
            cancel() {
              canceled = true;
            },
          }),
          duplex: 'half',
        } as RequestInit),
      )
    ).status,
    413,
  );
  assert.equal(
    canceled,
    true,
    'oversized streams stop before reading the remainder',
  );
  assert.equal(messages.length, 1);
});

void test('operation timings remain separate and accept only bounded, anonymous fields', async (t) => {
  const messages: string[] = [];
  t.mock.method(console, 'log', (message: string) => messages.push(message));
  const operations = [
    { area: 'search', phase: 'first', ms: 100, source: 'network' },
    { area: 'search', phase: 'first', ms: 200, source: 'memory' },
    { area: 'search', phase: 'complete', ms: 350, source: 'network' },
  ];
  const send = (body: unknown) =>
    POST(
      new Request('https://example.test/api/performance', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  const body = { device: 'desktop', metrics: {}, operations };
  assert.equal((await send(body)).status, 204);
  assert.deepEqual(JSON.parse(messages[0]), {
    event: 'frontend_performance',
    version: 2,
    ...body,
  });
  for (const operation of [
    { ...operations[0], query: 'private query' },
    { ...operations[0], area: 'private recording' },
    { ...operations[0], source: 'https://private.test' },
    { ...operations[0], phase: 'other' },
    { ...operations[0], ms: -1 },
    { ...operations[0], ms: 600_001 },
    { ...operations[0], ms: '100' },
    null,
  ])
    assert.equal(
      (await send({ ...body, operations: [operation] })).status,
      400,
    );
  for (const invalid of [
    { ...body, operations: Array(9).fill(operations[0]) },
    { ...body, operations: {} },
    { ...body, operations: [], metrics: [] },
    { ...body, operations: [], metrics: { searchVisibleMs: 300 } },
    { ...body, operations: [] },
  ])
    assert.equal((await send(invalid)).status, 400);
  assert.equal(messages.length, 1);
});
