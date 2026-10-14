import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesQueue } from '../packages/notes-only/src/queue.js';
import {
  ServerSessionAdapter,
  verifySchema,
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
