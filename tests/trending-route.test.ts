import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function chartRoute(
  flags: Record<string, unknown> = {},
  failure = false,
) {
  const data = {
    trending: [{ id: 42 }],
    total: 1,
    sampled: 1,
    partial: false,
    stale: false,
    fetchedAt: '2026-10-19T12:00:00.000Z',
    seen: 'private',
    index: { private: true },
    nextPage: 10,
    nextId: 99,
    ...flags,
  };
  const compiled = await build({
    entryPoints: ['app/api/discover/route.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'chart-response-fixture',
        setup(builder) {
          builder.onResolve(
            { filter: /^@\/lib\/(trending-cache|search-db)$/ },
            ({ path }) => ({ path, namespace: 'chart-fixture' }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: 'chart-fixture' },
            ({ path }) => ({
              contents: path.endsWith('search-db')
                ? 'export function searchDatabase() { throw new Error("Unexpected database access") }'
                : `
            export class TrendingBusyError extends Error {}
            export function createTrendingService() { return async () => {
              if (${failure}) throw new TrendingBusyError('Chart refresh is busy');
              return ${JSON.stringify(data)};
            } }
          `,
              loader: 'js',
            }),
          );
        },
      },
    ],
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64')
  ) as Promise<{
    GET(this: void, request: Request): Promise<Response>;
  }>;
}

void test('complete saved charts remain briefly cacheable while stale or refreshing and preserve their labels', async () => {
  for (const flags of [
    { stale: true },
    { refreshing: true },
    { stale: true, refreshing: true },
  ]) {
    const { GET } = await chartRoute(flags);
    for (const query of ['period=all', 'period=day&cached=1']) {
      const response = await GET(
        new Request('https://example.test/api/discover?' + query),
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('Cache-Control'),
        'public, max-age=0, s-maxage=30',
      );
      const data = await response.json();
      for (const [key, value] of Object.entries(flags))
        assert.equal(data[key], value);
      for (const key of ['index', 'seen', 'nextId', 'nextPage'])
        assert.equal(data[key], undefined);
      assert.equal(data.fetchedAt, '2026-10-19T12:00:00.000Z');
    }
  }
});

void test('partial charts and live scan requests remain uncached', async () => {
  for (const flags of [
    { partial: true },
    { partial: true, stale: true, refreshing: true },
  ]) {
    const { GET } = await chartRoute(flags);
    const response = await GET(
      new Request('https://example.test/api/discover?period=all&cached=1'),
    );
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  const { GET } = await chartRoute({ stale: true, refreshing: true });
  for (const period of ['day', 'week']) {
    const response = await GET(
      new Request('https://example.test/api/discover?period=' + period),
    );
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

void test('fresh charts retain their current cache policy and failures remain uncached', async () => {
  const ready = await chartRoute();
  const fresh = await ready.GET(
    new Request('https://example.test/api/discover?period=all'),
  );
  assert.equal(
    fresh.headers.get('Cache-Control'),
    'public, max-age=60, s-maxage=300, stale-while-revalidate=300',
  );
  const busy = await chartRoute({}, true);
  const failed = await busy.GET(
    new Request('https://example.test/api/discover?period=all'),
  );
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('Cache-Control'), 'no-store');
});
