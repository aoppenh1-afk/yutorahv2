import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { control } from './transcription-control.mjs';

const targetId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const jobId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const snapshot = {
  settings: { model: 'test-model', worker_enabled: true, notes_enabled: true },
  totals: [{ status: 'queued', count: 3 }],
  runtime: { models: ['test-model', 'other-model'], state: 'running' },
  jobs: [{ id: jobId }],
  targets: [
    {
      id: targetId,
      kind: 'series',
      upstream_id: '4233',
      recording_limit: 50,
      enabled: false,
      teacher_filter: '80714',
    },
  ],
};

test('local HTTP control preserves scope and distinguishes notes actions', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      path: req.url,
      method: req.method,
      headers: req.headers,
      body: body ? JSON.parse(body) : undefined,
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/api/operator/status' ? snapshot : { ok: true },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previousPort = process.env.YUTORAH_OPERATOR_PORT;
  process.env.YUTORAH_OPERATOR_PORT = String(server.address().port);
  try {
    assert.deepEqual(await control(['status']), {
      settings: snapshot.settings,
      totals: snapshot.totals,
      runtime: snapshot.runtime,
    });
    await control(['budget', targetId, '60']);
    assert.deepEqual(requests.at(-1).body, {
      kind: 'series',
      upstreamId: '4233',
      limit: 60,
      enabled: false,
      teacherId: '80714',
    });
    await control(['enable', targetId]);
    assert.deepEqual(requests.at(-1).body, {
      kind: 'series',
      upstreamId: '4233',
      limit: 50,
      enabled: true,
      teacherId: '80714',
    });
    await control(['add-series', '4233', '--limit', '70']);
    assert.equal(requests.at(-1).body.teacherId, '80714');
    await control(['retry', jobId, '--notes']);
    assert.deepEqual(requests.at(-1).body, {
      id: jobId,
      action: 'retry',
      kind: 'notes',
    });
    assert.equal(requests.at(-1).headers['x-operator-request'], '1');
    assert.equal(requests.at(-1).headers['content-type'], 'application/json');
    await control(['notes', 'off']);
    assert.deepEqual(requests.at(-1).body, {
      ...snapshot.settings,
      notes_enabled: false,
    });
    await control(['pause']);
    assert.equal(requests.at(-1).path, '/api/operator/stop');
  } finally {
    if (previousPort === undefined) delete process.env.YUTORAH_OPERATOR_PORT;
    else process.env.YUTORAH_OPERATOR_PORT = previousPort;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('invalid controls fail before queue mutations', async () => {
  const writes = [];
  const request = async (path, data) => {
    if (data !== undefined) writes.push({ path, data });
    return snapshot;
  };
  for (const args of [
    ['add-teacher', '80714'],
    ['add-teacher', '80714', '--limit', '0'],
    ['add-teacher', '80714', '--limit', '10', '--teacher', '80714'],
    ['add-series', '4233', '--limit', '10', '--limit', '20'],
    ['scan', '11'],
    ['pause', 'extra'],
    ['retry', jobId, '--unknown'],
    ['budget', targetId, '10001'],
    ['notes', 'maybe'],
    ['model', 'unadvertised'],
    ['content', 'https://example.org'],
    ['enable', jobId],
  ])
    await assert.rejects(control(args, { request }));
  assert.deepEqual(writes, []);
});

test('HTTP errors surface a non-success result', async () => {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Provider unavailable' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previousPort = process.env.YUTORAH_OPERATOR_PORT;
  process.env.YUTORAH_OPERATOR_PORT = String(server.address().port);
  try {
    await assert.rejects(
      control(['scan']),
      /Operator HTTP 503: Provider unavailable/,
    );
  } finally {
    if (previousPort === undefined) delete process.env.YUTORAH_OPERATOR_PORT;
    else process.env.YUTORAH_OPERATOR_PORT = previousPort;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
