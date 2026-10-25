import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { runCatalogWarm } from '../scripts/catalog-runner.mjs';

function fixture(handle) {
  let clock = 0;
  const calls = [],
    waits = [],
    events = [];
  return {
    calls,
    waits,
    events,
    options: {
      base: new URL('https://website.test'),
      token: 'fixture-secret',
      collections: 12,
      teachers: 4,
      maxRuntimeMs: 60000,
      now: () => clock,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      report: (event) => events.push(event),
      fetcher: async (url, init) => {
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, 'Bearer fixture-secret');
        const params = Object.fromEntries(url.searchParams);
        calls.push(params);
        return handle(params, calls);
      },
    },
  };
}
const plan = () => Response.json({ collections: [42], teachers: [7] });

void test('plan and resource 503s recover without counting successful retries as failures', async () => {
  const f = fixture((params, calls) => {
    const attempt = calls.filter((call) => call.kind === params.kind).length;
    if (attempt === 1)
      return Response.json(
        {},
        { status: 503, headers: { 'Retry-After': '3' } },
      );
    return params.kind === 'plan' ? plan() : Response.json({ complete: true });
  });
  assert.deepEqual(await runCatalogWarm(f.options), {
    warmed: 2,
    partial: 0,
    pending: 0,
    budgetReached: false,
  });
  assert.equal(f.events.filter((e) => e.status === 'retrying').length, 3);
  assert.equal(f.waits.filter((ms) => ms === 3000).length, 3);
});

void test('network failures are retried without exposing provider exception contents', async () => {
  const f = fixture((params, calls) => {
    if (calls.length === 1)
      throw new Error('Authorization: Bearer fixture-secret');
    return params.kind === 'plan' ? plan() : Response.json({ complete: true });
  });
  assert.equal((await runCatalogWarm(f.options)).warmed, 2);
  assert.ok(!JSON.stringify(f.events).includes('fixture-secret'));
});

void test('persistent failures stay failed while other resources complete', async () => {
  const f = fixture((params) =>
    params.kind === 'plan'
      ? plan()
      : params.kind === 'collection'
        ? Response.json({}, { status: 503 })
        : Response.json({ complete: true }),
  );
  assert.deepEqual(await runCatalogWarm(f.options), {
    warmed: 1,
    partial: 1,
    pending: 0,
    budgetReached: false,
  });
  assert.equal(f.calls.filter((c) => c.kind === 'collection').length, 4);
  assert.equal(f.events.at(-1).reason, 'http-503');
});

void test('authentication failures are terminal and identify the failed resource', async () => {
  const f = fixture((params) =>
    params.kind === 'plan' ? plan() : Response.json({}, { status: 401 }),
  );
  assert.equal((await runCatalogWarm(f.options)).partial, 2);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.events[0], {
    kind: 'collection',
    id: '42',
    status: 'failed',
    reason: 'http-401',
  });
});

void test('Retry-After dates beyond the budget defer work without sleeping or claiming completion', async () => {
  const f = fixture((params) =>
    params.kind === 'plan'
      ? plan()
      : Response.json(
          {},
          {
            status: 429,
            headers: { 'Retry-After': new Date(60000).toUTCString() },
          },
        ),
  );
  f.options.maxRuntimeMs = 2000;
  const result = await runCatalogWarm(f.options);
  assert.equal(result.warmed, 0);
  assert.equal(result.pending, 2);
  assert.equal(result.budgetReached, true);
  assert.ok(f.waits.every((ms) => ms === 100));
});

void test('incomplete scans remain resumable and rotate behind independent resources', async () => {
  const f = fixture((params, calls) =>
    params.kind === 'plan'
      ? plan()
      : Response.json({
          complete:
            params.kind === 'teacher' ||
            calls.filter((c) => c.kind === 'collection').length > 1,
        }),
  );
  assert.equal((await runCatalogWarm(f.options)).warmed, 2);
  assert.deepEqual(
    f.calls.map((c) => c.kind),
    ['plan', 'collection', 'teacher', 'collection'],
  );
});

void test('the CLI exits successfully after a real HTTP server returns one temporary 503', async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    const kind = new URL(request.url, 'http://localhost').searchParams.get(
      'kind',
    );
    response.setHeader('Content-Type', 'application/json');
    if (kind === 'plan')
      return response.end(JSON.stringify({ collections: [42], teachers: [] }));
    if (++attempts === 1) {
      response.statusCode = 503;
      response.setHeader('Retry-After', '0');
      return response.end('{}');
    }
    response.end(JSON.stringify({ complete: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(
      process.execPath,
      [
        'scripts/warm-catalog.mjs',
        '--url',
        `http://127.0.0.1:${server.address().port}`,
      ],
      {
        env: {
          ...process.env,
          TRENDING_REFRESH_TOKEN: 'fixture-secret',
          GITHUB_STEP_SUMMARY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, output);
    assert.equal(attempts, 2);
    assert.match(output, /"warmed":1,"partial":0/);
    assert.doesNotMatch(output, /fixture-secret/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
