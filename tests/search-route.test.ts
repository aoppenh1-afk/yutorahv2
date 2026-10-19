import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function searchRoute(
  failure: { code: string; message: string },
  entry = 'app/api/search/route.ts',
) {
  const compiled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'search-failure-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: 'bindings',
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /^@\/lib\/catalog-server$/ }, () => ({
            path: 'catalog',
            namespace: 'fixture',
          }));
          builder.onLoad(
            { filter: /.*/, namespace: 'fixture' },
            ({ path }) => ({
              contents:
                path === 'bindings'
                  ? `export const env = { TRENDING_REFRESH_TOKEN: 'fixture-token', DB: { prepare() { return { bind() { return this }, async first() { throw Object.assign(new Error(${JSON.stringify(failure.message)}), { code: ${JSON.stringify(failure.code)} }) } } } } }`
                  : 'export function deferCatalogWork() {} export function getCatalogService() { throw new Error("Unexpected catalog write") }',
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
    POST(this: void, request: Request): Promise<Response>;
  }>;
}

void test('search reports database quota exhaustion without blaming YUTorah or exposing database details', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const logs: string[] = [];
  t.mock.method(console, 'error', (value: string) => logs.push(value));
  const { GET } = await searchRoute({
    code: '53000',
    message:
      'Your account or project has exceeded the quota. Upgrade your plan to increase limits. private-endpoint',
  });
  const response = await GET(
    new Request('https://example.test/api/search?q=rav+adler&page=1'),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.match(body.error, /database quota/i);
  assert.doesNotMatch(body.error, /YUTorah|private-endpoint|Upgrade/);
  assert.deepEqual(
    logs.map((value) => JSON.parse(value)),
    [{ event: 'search_database_quota_exceeded' }],
  );
});

void test('other resource errors retain the generic search failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  t.mock.method(console, 'error', () => {});
  const { GET } = await searchRoute({
    code: '53000',
    message: 'Other private resource failure',
  });
  const response = await GET(
    new Request('https://example.test/api/search?q=rav+adler&page=1'),
  );
  assert.equal(response.status, 502);
  assert.doesNotMatch((await response.json()).error, /private|quota/);
});

void test('protected chart refresh exposes a safe terminal quota code to its runner', async () => {
  const { POST } = await searchRoute(
    {
      code: '53000',
      message:
        'Your account or project has exceeded the quota. private-endpoint',
    },
    'app/api/discover/refresh/route.ts',
  );
  const response = await POST(
    new Request('https://example.test/api/discover/refresh?period=all', {
      method: 'POST',
      headers: { Authorization: 'Bearer fixture-token' },
    }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Retry-After'), null);
  const body = await response.json();
  assert.equal(body.code, 'DATABASE_QUOTA_EXCEEDED');
  assert.doesNotMatch(body.error, /private-endpoint/);
});
