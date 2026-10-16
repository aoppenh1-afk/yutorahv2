import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesQueue } from '../packages/notes-only/src/queue.js';
import {
  ServerSessionAdapter,
  verifySchema,
  OpenCodeServer,
  type ServerAPI,
} from '../packages/opencode-acp/src/server.js';
import {
  assertFreeCatalog,
  messageEvidence,
  MODEL_ID,
  type RuntimeMessage,
} from '../packages/opencode-acp/src/evidence.js';
import {
  validateQualification,
  type Qualification,
} from '../packages/notes-only/src/qualification.js';
import {
  SharedSessionMonitor,
  readEvents,
} from '../packages/opencode-acp/src/monitor.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { loopbackJSON } from '../packages/opencode-acp/src/transport.js';
import { performance } from 'node:perf_hooks';
const catalog = {
  providers: [
    {
      id: 'opencode',
      models: {
        [MODEL_ID]: {
          id: MODEL_ID,
          providerID: 'opencode',
          status: 'active',
          variants: { high: {} },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  ],
};
const user = (id: string): RuntimeMessage => ({
  info: {
    role: 'user',
    sessionID: id,
    agent: 'plan',
    model: { providerID: 'opencode', modelID: MODEL_ID, variant: 'high' },
  },
  parts: [{ type: 'text', text: 'full prompt' }],
});
const assistant = (id: string): RuntimeMessage => ({
  info: {
    role: 'assistant',
    sessionID: id,
    modelID: MODEL_ID,
    providerID: 'opencode',
    agent: 'plan',
    variant: 'high',
    cost: 0,
    tokens: {
      input: 12,
      output: 5,
      reasoning: 2,
      cache: { read: 0, write: 0 },
    },
    time: { completed: Date.now() },
    finish: 'stop',
  },
  parts: [{ type: 'text', text: '# Finished\n\n## Topic\n\nComplete prose.' }],
});
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'server-adapter-'));
  const queue = new NotesQueue(join(root, 'queue.sqlite'));
  t.after(async () => {
    queue.close();
    await rm(root, { recursive: true, force: true });
  });
  queue.enqueue([{ id: '1' }, { id: '2' }]);
  const job = queue.claim('fetching')!;
  return { root, queue, job };
}
function virtualRuntimeClock(t: test.TestContext) {
  let monotonic = 10000,
    wall = Date.now();
  t.mock.method(performance, 'now', () => monotonic);
  t.mock.method(Date, 'now', () => wall);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  return async (elapsed: number, clockJump = 0) => {
    monotonic += elapsed;
    wall += elapsed + clockJump;
    t.mock.timers.tick(elapsed);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
}
void test('zero-price guard rejects absent, changed, or priced input/output/cache models', () => {
  assert.doesNotThrow(() => assertFreeCatalog(catalog));
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const copy = structuredClone(catalog);
    const cost = copy.providers[0].models[MODEL_ID].cost;
    if (field === 'input' || field === 'output') cost[field] = 1;
    else cost.cache[field === 'cacheRead' ? 'read' : 'write'] = 1;
    assert.throws(() => assertFreeCatalog(copy), /paid_route/);
  }
  assert.throws(() => assertFreeCatalog({ providers: [] }), /configuration/);
});
void test('response identity, high effort, tool use, token metadata, and cost are verified independently', () => {
  const messages = [user('ses1'), assistant('ses1')];
  assert.equal(messageEvidence(messages, 'ses1').input, 12);
  const paid = structuredClone(messages);
  paid[1].info.cost = 1;
  assert.throws(() => messageEvidence(paid, 'ses1'), /paid_route/);
  const changed = structuredClone(messages);
  changed[0].info.model!.variant = 'medium';
  assert.throws(() => messageEvidence(changed, 'ses1'), /unconfirmed_identity/);
  const tool = structuredClone(messages);
  tool[1].parts!.push({ type: 'tool' });
  assert.throws(() => messageEvidence(tool, 'ses1'), /off_task/);
  const helper = structuredClone(messages);
  helper.push({
    ...assistant('ses1'),
    info: { ...assistant('ses1').info, modelID: 'priced-helper' },
  });
  assert.throws(() => messageEvidence(helper, 'ses1'), /unconfirmed_identity/);
});
void test('schema drift cannot silently remove explicit high effort or cancellation support', () => {
  assert.throws(() => verifySchema({ paths: {} }), /configuration/);
});
void test('concurrent requests create fresh explicitly associated sessions, then delete only their own sessions', async (t) => {
  const { queue, job } = await setup(t);
  const second = queue.claim('fetching')!;
  let counter = 0;
  const messages = new Map<string, RuntimeMessage[]>();
  const deleted: string[] = [];
  const titles: string[] = [];
  const api: ServerAPI = async (path, method = 'GET', body) => {
    if (path === '/session' && method === 'POST') {
      const title = (body as { title: string }).title;
      titles.push(title);
      const id = 'ses' + ++counter;
      messages.set(id, []);
      return { id, title };
    }
    if (path === '/permission') return [];
    if (path === '/session/status') return {};
    const id = path.split('/')[2];
    if (path.endsWith('/message') && method === 'POST') {
      const request = body as {
        model: { providerID: string; modelID: string };
        agent: string;
        variant: string;
        parts: Array<{ text: string }>;
      };
      assert.equal(request.variant, 'high');
      assert.equal(request.agent, 'plan');
      assert.equal(request.model.modelID, MODEL_ID);
      assert.match(request.parts[0].text, /complete transcript/);
      const result = assistant(id);
      messages.set(id, [user(id), result]);
      return result;
    }
    if (path.endsWith('/message')) return messages.get(id) ?? [];
    if (path.endsWith('/abort')) return true;
    if (method === 'DELETE') {
      deleted.push(id);
      return true;
    }
    assert.fail(path);
  };
  const adapter = new ServerSessionAdapter(api, queue, 'owned', 1000);
  const results = await Promise.all([
    adapter.request(
      job,
      'request1',
      'complete transcript one',
      new AbortController().signal,
    ),
    adapter.request(
      second,
      'request2',
      'complete transcript two',
      new AbortController().signal,
    ),
  ]);
  assert.equal(results.length, 2);
  assert.equal(new Set(titles).size, 2);
  assert.equal(deleted.length, 2);
  assert.equal(
    queue.db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE state='active'")
      .get()?.count,
    0,
  );
});
void test('a hung session is aborted and acknowledged idle before deletion; the next session remains usable', async (t) => {
  const { queue, job } = await setup(t);
  let aborted = false,
    deleted = false;
  const api: ServerAPI = async (path, method = 'GET', body, signal) => {
    if (path === '/session' && method === 'POST')
      return { id: 'sesHung', title: (body as { title: string }).title };
    if (path === '/permission') return [];
    if (path === '/session/status')
      return aborted ? {} : { sesHung: { type: 'busy' } };
    if (path.endsWith('/message') && method === 'POST')
      return new Promise((_, reject) =>
        signal!.addEventListener(
          'abort',
          () => reject(new Error('client timeout')),
          { once: true },
        ),
      );
    if (path.endsWith('/message')) return [];
    if (path.endsWith('/abort')) {
      aborted = true;
      return true;
    }
    if (method === 'DELETE') {
      assert.equal(aborted, true);
      deleted = true;
      return true;
    }
    assert.fail(path);
  };
  await assert.rejects(
    new ServerSessionAdapter(api, queue, 'owned', 30).request(
      job,
      'request',
      'complete transcript',
      new AbortController().signal,
    ),
    /timeout/,
  );
  assert.equal(deleted, true);
});
void test('permission events are denied and off-task sessions cannot hang or become accepted', async (t) => {
  const { queue, job } = await setup(t);
  let denied = false;
  const api: ServerAPI = async (path, method = 'GET', body, signal) => {
    if (path === '/session' && method === 'POST')
      return { id: 'sesTool', title: (body as { title: string }).title };
    if (path === '/permission') return [{ id: 'per1', sessionID: 'sesTool' }];
    if (path === '/permission/per1/reply') {
      assert.deepEqual(body, { reply: 'reject' });
      denied = true;
      return true;
    }
    if (path === '/session/status') return {};
    if (path.endsWith('/abort') || method === 'DELETE') return true;
    if (path.endsWith('/message') && method === 'POST')
      return new Promise((_, reject) => {
        if (signal!.aborted) reject(new Error('aborted'));
        else
          signal!.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
      });
    if (path.endsWith('/message')) return [];
    assert.fail(path);
  };
  await assert.rejects(
    new ServerSessionAdapter(api, queue, 'owned', 1000).request(
      job,
      'request',
      'full source',
      new AbortController().signal,
    ),
    /off_task/,
  );
  assert.equal(denied, true);
});
void test('server-wide failure retains uncertain ownership; restart reconciliation removes owned sessions including the create-ledger gap', async (t) => {
  const { queue, job } = await setup(t);
  queue.db
    .prepare("INSERT INTO sessions VALUES('sesLost',?,?,?,'active',?)")
    .run(job.id, job.lease_token, 'server', Date.now());
  let failed = true;
  const removed: string[] = [];
  const api: ServerAPI = async (path, method) => {
    if (failed) throw new Error('server down');
    if (path === '/session')
      return [
        { id: 'sesLost', title: `owned:${job.id}:${job.lease_token}:request` },
        { id: 'sesGap', title: `owned:${job.id}:${job.lease_token}:another` },
        { id: 'sesHuman', title: 'human session' },
      ];
    if (path === '/session/status') return {};
    if (path.endsWith('/abort')) return true;
    if (method === 'DELETE') {
      removed.push(path.split('/')[2]);
      return true;
    }
    assert.fail(path);
  };
  const adapter = new ServerSessionAdapter(api, queue, 'owned', 1000);
  await assert.rejects(adapter.reconcile(), /server down/);
  assert.equal(
    queue.db.prepare("SELECT state FROM sessions WHERE id='sesLost'").get()
      ?.state,
    'active',
  );
  failed = false;
  await adapter.reconcile();
  assert.deepEqual(removed.sort(), ['sesGap', 'sesLost']);
});
void test('automated structural success cannot qualify a route without varied independent human source review and 24 hours of evidence', () => {
  assert.throws(
    () =>
      validateQualification({
        profile: 'a'.repeat(64),
        phase: 'quality',
        reviews: [],
      } as unknown as Qualification),
    /100 human/,
  );
  const e: Qualification = {
    profile: 'a'.repeat(64),
    phase: 'quality',
    concurrency: 2,
    memoryPeakBytes: 1024,
    reviews: Array.from({ length: 100 }, (_, i) => ({
      sourceHash: i.toString(16).padStart(64, '0'),
      referenceArtifactHash: 'b'.repeat(64),
      candidateArtifactHash: 'c'.repeat(64),
      reviewer: 'Human reviewer',
      accepted: true,
      criticalErrors: [],
      rejectionReasons: [],
      fullyHebrew: i === 0,
      subjects: ['Halacha', 'Gemara', 'Machshava'],
      speaker: 'Speaker ' + (i % 5),
      durationSeconds: i % 2 ? 600 : 4000,
    })),
  };
  assert.doesNotThrow(() => validateQualification(e));
  assert.throws(
    () => validateQualification({ ...e, phase: 'production' }),
    /cohort/,
  );
  const failed = structuredClone(e);
  failed.reviews[0].criticalErrors = ['Invented attribution'];
  assert.throws(() => validateQualification(failed), /failures/);
});

void test('pinned runtime aborts a missing session successfully but DELETE 404 still confirms owned cleanup', async (t) => {
  const { queue, job } = await setup(t);
  queue.db
    .prepare("INSERT INTO sessions VALUES('sesGone',?,?,?,'active',?)")
    .run(job.id, job.lease_token, 'acp', Date.now());
  let checkedMissing = false;
  const api: ServerAPI = async (path, method = 'GET') => {
    if (path.endsWith('/abort')) return true;
    if (path === '/session/status') return {};
    if (path === '/session/sesGone' && method === 'GET') {
      checkedMissing = true;
      throw Object.assign(new Error('not found'), { status: 404 });
    }
    if (path === '/session/sesGone' && method === 'DELETE')
      throw Object.assign(new Error('not found'), { status: 404 });
    assert.fail(path);
  };
  await new ServerSessionAdapter(api, queue, 'owned', 1000).cancelAndDelete(
    'sesGone',
  );
  assert.equal(checkedMissing, true);
  assert.equal(
    queue.db.prepare("SELECT state FROM sessions WHERE id='sesGone'").get()
      ?.state,
    'deleted',
  );
});

void test('concurrent expired guard refreshes coalesce and every caller sees a failed price/configuration check', async (t) => {
  const { root, queue } = await setup(t);
  const server = new OpenCodeServer(
    { executable: 'unused', root, deadlineMs: 1000, catalogTtlMs: 1 },
    queue,
  );
  t.mock.method(server, 'start', async () => {});
  let checks = 0;
  t.mock.method(server, 'verify', async () => {
    checks++;
    await delay(10);
    throw new Error('paid_route');
  });
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => server.guard()),
  );
  assert.equal(checks, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 6);
});

void test('pending session creation counts toward the six-session ceiling and a lost creation acknowledgement pauses admissions', async (t) => {
  const { queue, job } = await setup(t);
  let created = 0;
  const api: ServerAPI = async (path, method = 'GET', body) => {
    if (path === '/session' && method === 'POST')
      return {
        id: 'ses' + ++created,
        title: (body as { title: string }).title,
      };
    if (path === '/permission') return [];
    if (path === '/session/status') return {};
    const id = path.split('/')[2];
    if (path.endsWith('/message'))
      return method === 'POST' ? assistant(id) : [user(id), assistant(id)];
    if (path.endsWith('/abort') || method === 'DELETE') return true;
    assert.fail(path);
  };
  const adapter = new ServerSessionAdapter(api, queue, 'owned', 1000);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      adapter.request(
        job,
        'request' + i,
        'full source',
        new AbortController().signal,
      ),
    ),
  );
  assert.equal(created, 6);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 6);
  for (const result of results)
    if (result.status === 'rejected')
      assert.match(result.reason.message, /concurrency_limit/);
  const uncertain = new ServerSessionAdapter(
    async () => {
      throw new Error('lost response');
    },
    queue,
    'owned',
    1000,
  );
  await assert.rejects(
    uncertain.request(job, 'lost', 'full source', new AbortController().signal),
    (error: { code?: string; pause?: boolean }) =>
      error.code === 'session_uncertain' && error.pause === true,
  );
});

void test('successful startup reconciliation releases uncertain finished callbacks while preserving a newly admitted request awaiting its session', async (t) => {
  const { queue, job } = await setup(t);
  const insert = queue.db.prepare(
    "INSERT INTO requests(id,job_id,token,route,kind,started_at,ended_at,status,reserved_tokens) VALUES(?,?,?,'server-high','generation',?,?,'active',100)",
  );
  insert.run(
    'uncertain',
    job.id,
    job.lease_token,
    Date.now() - 120000,
    Date.now() - 1000,
  );
  insert.run('starting', job.id, job.lease_token, Date.now(), null);
  let failed = true;
  const adapter = new ServerSessionAdapter(
    async (path) => {
      if (failed) throw new Error('offline');
      assert.equal(path, '/session');
      return [];
    },
    queue,
    'owned',
    1000,
  );
  await assert.rejects(adapter.reconcile(), /offline/);
  assert.equal(
    queue.db.prepare("SELECT status FROM requests WHERE id='uncertain'").get()
      ?.status,
    'active',
  );
  failed = false;
  await adapter.reconcile();
  assert.equal(
    queue.db.prepare("SELECT status FROM requests WHERE id='uncertain'").get()
      ?.status,
    'reconciled_interrupted',
  );
  assert.equal(
    queue.db.prepare("SELECT status FROM requests WHERE id='starting'").get()
      ?.status,
    'active',
  );
});

void test('shared runtime monitoring uses one stream, rejects only owned permissions, and reconciles missed tool events after disconnect', async () => {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let opens = 0,
    permissionReads = 0,
    historyReads = 0,
    denied = 0,
    missedTool = false;
  const errors: string[] = [];
  let outputs = 0;
  const api: ServerAPI = async (path) => {
    if (path === '/permission') {
      permissionReads++;
      return [];
    }
    if (path === '/permission/perOwned/reply') {
      denied++;
      return true;
    }
    if (path.endsWith('/message')) {
      historyReads++;
      return missedTool && path.includes('ses2')
        ? [{ parts: [{ type: 'tool' }] }]
        : [];
    }
    assert.fail(path);
  };
  const monitor = new SharedSessionMonitor(
    api,
    async () => {
      opens++;
      return new ReadableStream({
        start(c) {
          streams.push(c);
        },
      });
    },
    { pollMs: 10, reconcileMs: 10000, retryMs: 10, idleMs: 1000 },
  );
  const watcher = {
    fail: (e: unknown) => errors.push((e as Error).message),
    output: () => {
      outputs++;
    },
  };
  const [release1, release2] = await Promise.all([
    monitor.watch('ses1', watcher),
    monitor.watch('ses2', watcher),
  ]);
  try {
    await delay(30);
    assert.equal(opens, 1);
    assert.ok(
      permissionReads <= 2,
      'global permission polling must not scale with sessions',
    );
    assert.ok(
      historyReads <= 3,
      'healthy SSE must not reread growing history every 500ms',
    );
    const send = (event: unknown) =>
      streams
        .at(-1)!
        .enqueue(
          new TextEncoder().encode(
            'data: ' + JSON.stringify({ payload: event }) + '\n\n',
          ),
        );
    send({
      type: 'permission.asked',
      properties: { id: 'perHuman', sessionID: 'sesHuman' },
    });
    send({
      type: 'message.updated',
      properties: { sessionID: 'ses1', info: { id: 'msgUser', role: 'user' } },
    });
    send({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses1',
        part: { messageID: 'msgUser', type: 'text', text: 'complete prompt' },
      },
    });
    send({
      type: 'message.updated',
      properties: {
        sessionID: 'ses1',
        info: { id: 'msgAssistant', role: 'assistant' },
      },
    });
    send({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses1',
        messageID: 'msgAssistant',
        delta: 'first output',
      },
    });
    send({
      type: 'permission.asked',
      properties: { id: 'perOwned', sessionID: 'ses1' },
    });
    await delay(10);
    assert.equal(denied, 1);
    assert.equal(outputs, 1);
    assert.deepEqual(errors, ['off_task']);
    missedTool = true;
    streams.at(-1)!.close();
    await delay(300);
    assert.ok(opens >= 2);
    assert.ok(
      errors.length >= 2,
      'a tool event missed during disconnect must still fail reconciliation',
    );
  } finally {
    await release1();
    await release2();
  }
});

void test('SSE parser handles split UTF-8, CRLF, multiline data, and bounded malformed events', async () => {
  const encoded = new TextEncoder().encode(
    'data: {"type":"message.part.delta",\r\ndata: "properties":{"sessionID":"ses1","delta":"שלום"}}\r\n\r\n',
  );
  const found: unknown[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < encoded.length; i++)
        c.enqueue(encoded.slice(i, i + 1));
      c.close();
    },
  });
  await readEvents(
    stream,
    new AbortController().signal,
    (e) => {
      found.push(e);
    },
    1000,
  );
  assert.deepEqual(found, [
    {
      type: 'message.part.delta',
      properties: { sessionID: 'ses1', delta: 'שלום' },
    },
  ]);
  await assert.rejects(
    readEvents(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: not-json\n\n'));
          c.close();
        },
      }),
      new AbortController().signal,
      () => {},
      1000,
    ),
  );
});

void test('local JSON transport waits for delayed headers, enforces cancellation through the body, bounds evidence, and preserves Retry-After', async (t) => {
  const server = createServer((req, res) => {
    assert.equal(
      req.headers.authorization,
      'Basic ' + Buffer.from('opencode:fixture').toString('base64'),
    );
    if (req.url === '/slow') {
      const timer = setTimeout(() => res.end('{"ok":true}'), 100);
      res.once('close', () => clearTimeout(timer));
    } else if (req.url === '/body') {
      res.writeHead(200);
      res.write('{');
    } else if (req.url === '/large') res.end('x'.repeat(100));
    else if (req.url === '/quota')
      res.writeHead(429, { 'Retry-After': '7' }).end('ignored');
    else res.writeHead(302, { Location: 'https://example.com' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const options = () => ({
    method: 'POST',
    password: 'fixture',
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(await loopbackJSON(url + '/slow', options()), { ok: true });
  await assert.rejects(
    loopbackJSON(url + '/slow', {
      ...options(),
      signal: AbortSignal.timeout(20),
    }),
  );
  await assert.rejects(
    loopbackJSON(url + '/body', {
      ...options(),
      signal: AbortSignal.timeout(30),
    }),
  );
  await assert.rejects(
    loopbackJSON(url + '/large', { ...options(), maxBytes: 32 }),
    /byte limit/,
  );
  await assert.rejects(
    loopbackJSON(url + '/quota', options()),
    (error: { status?: number; retryAfter?: string }) =>
      error.status === 429 && error.retryAfter === '7',
  );
  await assert.rejects(
    loopbackJSON(url + '/redirect', options()),
    (error: { status?: number }) => error.status === 302,
  );
  await assert.rejects(
    loopbackJSON('https://example.com', options()),
    /loopback/,
  );
});

void test('silent provider sessions time out despite healthy SSE heartbeats and unchanged reconciliation history', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const errors: string[] = [];
  const monitor = new SharedSessionMonitor(
    async (path) =>
      path === '/permission'
        ? []
        : [
            {
              info: { role: 'assistant', id: 'msg1' },
              parts: [{ type: 'reasoning', text: 'initial reasoning' }],
            },
          ],
    async () =>
      new ReadableStream({
        start(c) {
          controller = c;
        },
      }),
    { pollMs: 5, reconcileMs: 10, retryMs: 5, idleMs: 1000, stallMs: 60 },
  );
  const release = await monitor.watch('sesStalled', {
    fail: (error) => errors.push((error as Error).message),
    output: () => {},
  });
  const heartbeat = setInterval(
    () =>
      controller.enqueue(
        new TextEncoder().encode('data: {"type":"server.heartbeat"}\n\n'),
      ),
    5,
  );
  try {
    await delay(180);
    assert.deepEqual(
      errors,
      ['timeout'],
      'unchanged reasoning must not keep a worker occupied',
    );
  } finally {
    clearInterval(heartbeat);
    await release();
  }
});

void test('growing assistant output keeps a long request alive beyond the silence deadline', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const errors: unknown[] = [];
  const monitor = new SharedSessionMonitor(
    async () => [],
    async () =>
      new ReadableStream({
        start(c) {
          controller = c;
        },
      }),
    { pollMs: 5, reconcileMs: 10, retryMs: 5, idleMs: 1000, stallMs: 80 },
  );
  const release = await monitor.watch('sesGrowing', {
    fail: (e) => errors.push(e),
    output: () => {},
  });
  const send = (event: unknown) =>
    controller.enqueue(
      new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'),
    );
  send({
    type: 'message.updated',
    properties: {
      info: { sessionID: 'sesGrowing', id: 'msg1', role: 'assistant' },
    },
  });
  const progress = setInterval(
    () =>
      send({
        type: 'message.part.delta',
        properties: {
          sessionID: 'sesGrowing',
          messageID: 'msg1',
          delta: 'more output',
        },
      }),
    15,
  );
  try {
    await delay(220);
    assert.deepEqual(errors, []);
  } finally {
    clearInterval(progress);
    await release();
  }
});

void test('a silent provider request aborts and deletes its owned session before releasing the worker', async (t) => {
  const { queue, job } = await setup(t);
  let aborted = false;
  let deleted = false;
  const api: ServerAPI = async (path, method = 'GET', body, signal) => {
    if (path === '/session' && method === 'POST')
      return { id: 'sesSilent', title: (body as { title: string }).title };
    if (path === '/permission') return [];
    if (path === '/session/status')
      return aborted ? {} : { sesSilent: { type: 'busy' } };
    if (path.endsWith('/message') && method === 'POST')
      return new Promise((_, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    if (path.endsWith('/message')) return [];
    if (path.endsWith('/abort')) {
      aborted = true;
      return true;
    }
    if (method === 'DELETE') {
      assert.equal(aborted, true);
      deleted = true;
      return true;
    }
    assert.fail(path);
  };
  const adapter = new ServerSessionAdapter(api, queue, 'owned', 5000);
  adapter.monitor.settings.stallMs = 40;
  const started = Date.now();
  await assert.rejects(
    adapter.request(
      job,
      'silent',
      'full transcript',
      new AbortController().signal,
    ),
    /timeout/,
  );
  assert.ok(
    Date.now() - started < 1000,
    'silence must be detected before the full request deadline',
  );
  assert.equal(deleted, true);
  assert.equal(
    queue.db
      .prepare("SELECT COUNT(*) n FROM sessions WHERE state!='deleted'")
      .get()?.n,
    0,
  );
});

void test('a forward wall-clock adjustment does not time out a newly active session', async (t) => {
  const errors: unknown[] = [];
  const monitor = new SharedSessionMonitor(async () => [], undefined, {
    pollMs: 5,
    reconcileMs: 10,
    retryMs: 5,
    idleMs: 1000,
    stallMs: 200,
  });
  const release = await monitor.watch('sesClockForward', {
    fail: (e) => errors.push(e),
    output: () => {},
  });
  const wall = Date.now();
  t.mock.method(Date, 'now', () => wall + 360000);
  try {
    await delay(100);
    assert.deepEqual(
      errors,
      [],
      'a clock adjustment is not elapsed inference silence',
    );
  } finally {
    await release();
  }
});

void test('a backward wall-clock adjustment cannot keep a silent session alive indefinitely', async (t) => {
  const errors: string[] = [];
  const monitor = new SharedSessionMonitor(async () => [], undefined, {
    pollMs: 5,
    reconcileMs: 10,
    retryMs: 5,
    idleMs: 1000,
    stallMs: 40,
  });
  const release = await monitor.watch('sesClockBackward', {
    fail: (e) => errors.push((e as Error).message),
    output: () => {},
  });
  const wall = Date.now();
  t.mock.method(Date, 'now', () => wall - 360000);
  try {
    await delay(120);
    assert.deepEqual(
      errors,
      ['timeout'],
      'real elapsed silence must remain bounded when the clock moves backward',
    );
  } finally {
    await release();
  }
});

void test('a request stranded across a host discontinuity releases its worker after bounded recovery', async (t) => {
  let monotonic = 10000,
    wall = Date.now();
  t.mock.method(performance, 'now', () => monotonic);
  t.mock.method(Date, 'now', () => wall);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const errors: string[] = [];
  const newErrors: string[] = [];
  let text = '';
  const monitor = new SharedSessionMonitor(
    async (path) =>
      path === '/permission'
        ? []
        : [
            {
              info: { role: 'assistant', id: 'msg1' },
              parts: [{ type: 'reasoning', text }],
            },
          ],
    undefined,
    {
      pollMs: 1000,
      reconcileMs: 30000,
      retryMs: 1000,
      idleMs: 45000,
    },
  );
  const advance = async (elapsed: number, clockJump = 0) => {
    monotonic += elapsed;
    wall += elapsed + clockJump;
    t.mock.timers.tick(elapsed);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const release = await monitor.watch('sesStranded', {
    fail: (e) => errors.push((e as Error).message),
    output: () => {},
  });
  let releaseNew: (() => Promise<void>) | undefined;
  try {
    await advance(1000);
    await advance(17000, 137000);
    text = 'queued catch-up output';
    await advance(1000);
    releaseNew = await monitor.watch('sesNewAfterPause', {
      fail: (e) => newErrors.push((e as Error).message),
      output: () => {},
    });
    for (let i = 0; i < 70; i++) await advance(1000);
    assert.deepEqual(
      errors,
      ['timeout'],
      'A corroborated host pause must not strand a worker for another three minutes',
    );
    assert.deepEqual(
      newErrors,
      [],
      'Newly admitted sessions retain the ordinary deadline',
    );
    assert.equal(monitor.status().resumeRecoveries, 1);
  } finally {
    await release();
    await releaseNew?.();
  }
});

void test('a clock correction without an execution pause retains the ordinary silence deadline', async (t) => {
  let monotonic = 10000,
    wall = Date.now();
  t.mock.method(performance, 'now', () => monotonic);
  t.mock.method(Date, 'now', () => wall);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const errors: string[] = [];
  const monitor = new SharedSessionMonitor(async () => [], undefined, {
    pollMs: 1000,
    reconcileMs: 30000,
    retryMs: 1000,
    idleMs: 45000,
  });
  const release = await monitor.watch('sesClockOnly', {
    fail: (e) => errors.push((e as Error).message),
    output: () => {},
  });
  try {
    for (let i = 0; i < 70; i++) {
      monotonic += 1000;
      wall += 1000 + (i === 1 ? 137000 : 0);
      t.mock.timers.tick(1000);
      for (let j = 0; j < 20; j++) await Promise.resolve();
    }
    assert.deepEqual(errors, []);
  } finally {
    await release();
  }
});

void test('recovery never extends an ordinary silence deadline that already elapsed', async (t) => {
  const advance = virtualRuntimeClock(t);
  const errors: string[] = [];
  const monitor = new SharedSessionMonitor(async () => [], undefined, {
    pollMs: 1000,
    reconcileMs: 30000,
    retryMs: 1000,
    idleMs: 45000,
  });
  const release = await monitor.watch('sesAlreadySilent', {
    fail: (e) => errors.push((e as Error).message),
    output: () => {},
  });
  try {
    for (let i = 0; i < 165; i++) await advance(1000);
    await advance(17000, 137000);
    for (let i = 0; i < 8; i++) await advance(1000);
    assert.deepEqual(errors, ['timeout']);
  } finally {
    await release();
  }
});

void test('output that actually resumes after the catch-up grace restores the ordinary deadline', async (t) => {
  const advance = virtualRuntimeClock(t);
  let text = '';
  const errors: string[] = [];
  const monitor = new SharedSessionMonitor(
    async (path) =>
      path === '/permission'
        ? []
        : [
            {
              info: { role: 'assistant', id: 'msg1' },
              parts: [{ type: 'reasoning', text }],
            },
          ],
    undefined,
    { pollMs: 1000, reconcileMs: 30000, retryMs: 1000, idleMs: 45000 },
  );
  const release = await monitor.watch('sesRecovered', {
    fail: (e) => errors.push((e as Error).message),
    output: () => {},
  });
  try {
    await advance(1000);
    await advance(17000, 137000);
    text = 'queued output';
    for (let i = 0; i < 6; i++) await advance(1000);
    text += ' genuinely resumed progress';
    await advance(1000);
    for (let i = 0; i < 75; i++) await advance(1000);
    assert.deepEqual(errors, []);
    assert.equal(monitor.status().discontinuities, 1);
  } finally {
    await release();
  }
});

void test('post-pause recovery confirms owned cleanup and records its reason before returning capacity', async (t) => {
  const { queue, job } = await setup(t);
  const advance = virtualRuntimeClock(t);
  let aborted = false,
    deleted = false;
  const api: ServerAPI = async (path, method = 'GET', body, signal) => {
    if (path === '/session' && method === 'POST')
      return { id: 'sesResume', title: (body as { title: string }).title };
    if (path === '/permission') return [];
    if (path === '/session/status')
      return aborted ? {} : { sesResume: { type: 'busy' } };
    if (path.endsWith('/message') && method === 'POST')
      return new Promise((_, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    if (path.endsWith('/message')) return [];
    if (path.endsWith('/abort')) {
      aborted = true;
      return true;
    }
    if (method === 'DELETE') {
      assert.equal(aborted, true);
      deleted = true;
      return true;
    }
    assert.fail(path);
  };
  const adapter = new ServerSessionAdapter(api, queue, 'owned', 1200000);
  const controller = new AbortController();
  const request = adapter
    .request(job, 'resume-cleanup', 'complete transcript', controller.signal)
    .then(
      () => ({ code: 'completed' }),
      (e: Error) => ({ code: e.message }),
    );
  try {
    await advance(1000);
    await advance(17000, 137000);
    for (let i = 0; i < 70; i++) await advance(1000);
    assert.equal(deleted, true);
    assert.deepEqual(await request, { code: 'timeout' });
    assert.equal(
      queue.db
        .prepare("SELECT COUNT(*) n FROM sessions WHERE state!='deleted'")
        .get()?.n,
      0,
    );
    assert.ok(
      queue.db
        .prepare(
          "SELECT 1 FROM request_observations WHERE request_id='resume-cleanup' AND phase='resume_watchdog_timeout'",
        )
        .get(),
    );
    assert.ok(
      queue.db
        .prepare(
          "SELECT 1 FROM request_observations WHERE request_id='resume-cleanup' AND phase='runtime_discontinuity'",
        )
        .get(),
    );
  } finally {
    controller.abort();
    await request;
  }
});

void test('a complete verified response saved during a pause is recovered before any retry', async (t) => {
  const { queue, job } = await setup(t);
  const advance = virtualRuntimeClock(t);
  let complete = false,
    aborted = false;
  const api: ServerAPI = async (path, method = 'GET', body, signal) => {
    if (path === '/session' && method === 'POST')
      return {
        id: 'sesResumeComplete',
        title: (body as { title: string }).title,
      };
    if (path === '/permission' || path === '/session/status')
      return path === '/permission' ? [] : {};
    if (path.endsWith('/message') && method === 'POST')
      return new Promise((_, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    if (path.endsWith('/message'))
      return complete
        ? [user('sesResumeComplete'), assistant('sesResumeComplete')]
        : [];
    if (path.endsWith('/abort')) {
      aborted = true;
      return true;
    }
    if (method === 'DELETE') return true;
    assert.fail(path);
  };
  const adapter = new ServerSessionAdapter(api, queue, 'owned', 1200000);
  const controller = new AbortController();
  const request = adapter.request(
    job,
    'resume-complete',
    'complete transcript',
    controller.signal,
  );
  try {
    await advance(1000);
    complete = true;
    await advance(17000, 137000);
    for (let i = 0; i < 5; i++) await advance(1000);
    const result = await request;
    assert.match(result.value, /Complete prose/);
    assert.equal(result.evidence.cost, 0);
    assert.equal(aborted, true);
    assert.equal(adapter.monitor.status().resumeRecoveries, 0);
  } finally {
    controller.abort();
    await request.catch(() => {});
  }
});

void test('silence expiry reconciles output missed by the stream before cancelling a session', async () => {
  let text = '';
  const errors: string[] = [];
  const monitor = new SharedSessionMonitor(
    async (path) =>
      path === '/permission'
        ? []
        : [
            {
              info: { role: 'assistant', id: 'msg1' },
              parts: [{ type: 'reasoning', text }],
            },
          ],
    undefined,
    {
      pollMs: 10000,
      reconcileMs: 10000,
      retryMs: 5,
      idleMs: 1000,
      stallMs: 60,
    },
  );
  const release = await monitor.watch('sesMissed', {
    fail: (e) => errors.push((e as Error).message),
    output: () => {},
  });
  await delay(10);
  text = 'output generated while the event consumer was delayed';
  try {
    await delay(75);
    assert.deepEqual(
      errors,
      [],
      'fresh persisted progress must be reconciled before declaring silence',
    );
    await delay(100);
    assert.deepEqual(
      errors,
      ['timeout'],
      'unchanged persisted output must still have a bounded deadline',
    );
  } finally {
    await release();
  }
});

void test('a delayed timer after a process pause gives queued output a bounded chance to resume', async () => {
  let text = '';
  const errors: string[] = [];
  const monitor = new SharedSessionMonitor(
    async (path) =>
      path === '/permission'
        ? []
        : [
            {
              info: { role: 'assistant', id: 'msg1' },
              parts: [{ type: 'reasoning', text }],
            },
          ],
    undefined,
    {
      pollMs: 10000,
      reconcileMs: 10000,
      retryMs: 5,
      idleMs: 1000,
      stallMs: 80,
      resumeGraceMs: 60,
    },
  );
  const release = await monitor.watch('sesPaused', {
    fail: (e) => errors.push((e as Error).message),
    output: () => {},
  });
  try {
    await delay(10);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    setTimeout(() => {
      text = 'output queued during the pause';
    }, 0);
    await delay(30);
    assert.deepEqual(
      errors,
      [],
      'a delayed watchdog must let queued server output catch up',
    );
    await delay(200);
    assert.deepEqual(
      errors,
      ['timeout'],
      'a pause cannot grant an unlimited extension to a genuinely silent request',
    );
  } finally {
    await release();
  }
});

void test('a completed verified history recovers a lost prompt response without repeating inference', async (t) => {
  const { queue, job } = await setup(t);
  let sent = false,
    aborted = false,
    deleted = false,
    prompts = 0;
  const api: ServerAPI = async (path, method = 'GET', body, signal) => {
    if (path === '/session' && method === 'POST')
      return { id: 'sesSaved', title: (body as { title: string }).title };
    if (path === '/permission') return [];
    if (path === '/session/status') return {};
    if (path.endsWith('/message') && method === 'POST') {
      sent = true;
      prompts++;
      return new Promise((_, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    }
    if (path.endsWith('/message'))
      return sent ? [user('sesSaved'), assistant('sesSaved')] : [];
    if (path.endsWith('/abort')) {
      aborted = true;
      return true;
    }
    if (method === 'DELETE') {
      deleted = true;
      return true;
    }
    assert.fail(path);
  };
  const adapter = new ServerSessionAdapter(api, queue, 'owned', 300);
  adapter.monitor.settings.pollMs = 5;
  adapter.monitor.settings.reconcileMs = 10;
  const result = await adapter.request(
    job,
    'lost-response',
    'full source',
    new AbortController().signal,
  );
  assert.match(result.value, /Complete prose/);
  assert.equal(prompts, 1);
  assert.equal(aborted && deleted, true);
});

void test('history recovery retains identity, price, completion and tool checks', async (t) => {
  for (const [variant, expected] of [
    ['paid', 'paid_route'],
    ['identity', 'unconfirmed_identity'],
    ['tool', 'off_task'],
    ['truncated', 'incomplete_output'],
  ]) {
    const { queue, job } = await setup(t);
    let sent = false,
      deleted = false;
    const reply = assistant('sesRecover');
    if (variant === 'paid') reply.info.cost = 1;
    if (variant === 'identity') reply.info.modelID = 'another-model';
    if (variant === 'tool') reply.parts!.push({ type: 'tool' });
    if (variant === 'truncated') reply.info.finish = 'length';
    const api: ServerAPI = async (path, method = 'GET', body, signal) => {
      if (path === '/session' && method === 'POST')
        return { id: 'sesRecover', title: (body as { title: string }).title };
      if (path === '/permission') return [];
      if (path === '/session/status') return {};
      if (path.endsWith('/message') && method === 'POST') {
        sent = true;
        return new Promise((_, reject) =>
          signal!.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          ),
        );
      }
      if (path.endsWith('/message'))
        return sent ? [user('sesRecover'), reply] : [];
      if (path.endsWith('/abort')) return true;
      if (method === 'DELETE') {
        deleted = true;
        return true;
      }
      assert.fail(path);
    };
    const adapter = new ServerSessionAdapter(api, queue, 'owned', 1000);
    adapter.monitor.settings.pollMs = 5;
    await assert.rejects(
      adapter.request(
        job,
        variant!,
        'full source',
        new AbortController().signal,
      ),
      (e: { code?: string }) => e.code === expected,
      variant,
    );
    assert.equal(deleted, true, variant);
  }
});

void test('a hung final history check is bounded and still confirms owned session cleanup', async (t) => {
  const { queue, job } = await setup(t);
  let reads = 0,
    deleted = false;
  const api: ServerAPI = async (path, method = 'GET', body, signal) => {
    if (path === '/session' && method === 'POST')
      return { id: 'sesRecheck', title: (body as { title: string }).title };
    if (path === '/permission') return [];
    if (path === '/session/status') return {};
    if (path.endsWith('/message')) {
      if (method === 'GET' && reads++ === 0) return [];
      return new Promise((_, reject) =>
        signal!.addEventListener('abort', () => reject(signal!.reason), {
          once: true,
        }),
      );
    }
    if (path.endsWith('/abort')) return true;
    if (method === 'DELETE') {
      deleted = true;
      return true;
    }
    assert.fail(path);
  };
  const adapter = new ServerSessionAdapter(api, queue, 'owned', 5000);
  adapter.monitor.settings.stallMs = 30;
  adapter.monitor.settings.recheckMs = 20;
  const start = performance.now();
  await assert.rejects(
    adapter.request(
      job,
      'hung-recheck',
      'full source',
      new AbortController().signal,
    ),
  );
  assert.ok(
    performance.now() - start < 1000,
    'a failed readback cannot indefinitely reserve a worker',
  );
  assert.equal(deleted, true);
});
