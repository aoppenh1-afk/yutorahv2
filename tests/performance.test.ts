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
    device: 'mobile',
    cache: 'cold',
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
