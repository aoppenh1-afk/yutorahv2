import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runNotesPool } from '../deploy/notes-only/pool.mjs';

function fixture(count = 12) {
  const jobs = Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    attempts: 1,
  }));
  const claims = [],
    retries = [],
    blocked = [],
    events = [];
  const queue = {
    claim() {
      const job = jobs.shift();
      if (job) claims.push(job.id);
      return job;
    },
    retry(...args) {
      retries.push(args);
    },
    blocked(...args) {
      blocked.push(args);
    },
    recheckMissing() {},
  };
  return {
    jobs,
    claims,
    retries,
    blocked,
    events,
    queue,
    signal: new AbortController().signal,
    paceMs: 0,
    log: (event) => events.push(event),
  };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await nextTurn();
  }
  assert.fail('Pool did not reach the expected state.');
}

test('six distinct transcripts run concurrently and a freed slot refills immediately', async () => {
  const f = fixture();
  const gates = new Map();
  const run = runNotesPool({
    ...f,
    processJob: (job) => new Promise((resolve) => gates.set(job.id, resolve)),
  });
  await until(() => gates.size === 6);
  assert.deepEqual(f.claims, ['1', '2', '3', '4', '5', '6']);
  gates.get('3')('completed');
  await until(() => gates.has('7'));
  assert.ok(!gates.has('8'));
  // Jobs 1, 2, 4, 5, 6 are still active when job 7 starts.
  while (f.events.filter((e) => e.status === 'completed').length < 12) {
    for (const resolve of gates.values()) resolve('completed');
    await nextTurn();
  }
  assert.deepEqual(await run, { processed: 12, failed: false });
  assert.equal(new Set(f.claims).size, 12);
  assert.equal(Math.max(...f.events.map((e) => e.active)), 6);
});

test('bounded pilots never claim more jobs than their limit', async () => {
  const f = fixture();
  const result = await runNotesPool({
    ...f,
    limit: 2,
    processJob: async () => 'completed',
  });
  assert.equal(result.processed, 2);
  assert.equal(f.claims.length, 2);
  await assert.rejects(
    runNotesPool({ ...f, concurrency: 7 }),
    /between 1 and 6/,
  );
});

test('quota errors cool down all new work while allowing active jobs to finish', async () => {
  const f = fixture(4);
  let clock = 0;
  const times = [];
  const originalClaim = f.queue.claim.bind(f.queue);
  f.queue.claim = () => {
    times.push(clock);
    return originalClaim();
  };
  const result = await runNotesPool({
    ...f,
    concurrency: 2,
    follow: true,
    limit: 3,
    now: () => clock,
    sleep: async (ms) => {
      await nextTurn();
      clock += ms;
    },
    processJob: async (job) => {
      if (job.id === '1')
        throw Object.assign(new Error('quota'), {
          code: 'quota_exhausted',
          retryAfterMs: 180000,
        });
      return 'completed';
    },
  });
  assert.deepEqual(result, { processed: 3, failed: false });
  assert.deepEqual(f.retries, [['1', 'quota_exhausted', 180000]]);
  assert.ok(times[2] >= 180000);
});

test('abort drains every active session before returning and stops claiming', async () => {
  const f = fixture();
  const controller = new AbortController();
  const gates = new Map();
  let finished = false;
  const run = runNotesPool({
    ...f,
    signal: controller.signal,
    processJob: (job) => new Promise((resolve) => gates.set(job.id, resolve)),
  }).then((result) => {
    finished = true;
    return result;
  });
  await until(() => gates.size === 6);
  controller.abort();
  await nextTurn();
  assert.equal(finished, false);
  for (const resolve of gates.values()) resolve('completed');
  assert.equal((await run).processed, 6);
  assert.equal(f.claims.length, 6);
});

test('a retry stops a bounded pilot and drains the remaining jobs; conflicts are blocked', async () => {
  const f = fixture(6);
  const result = await runNotesPool({
    ...f,
    processJob: async (job) => {
      if (job.id === '1') throw new Error('checksum conflict');
      if (job.id === '2')
        throw Object.assign(new Error('offline'), { code: 'transport' });
      return 'completed';
    },
  });
  assert.equal(result.failed, true);
  assert.equal(result.processed, 5);
  assert.deepEqual(f.blocked, [['1', 'processing_failed']]);
  assert.deepEqual(f.retries, [['2', 'transport', 120000]]);
});

test('the scheduling deadline stops new claims and drains in-flight jobs', async () => {
  const f = fixture();
  let clock = 0;
  const result = await runNotesPool({
    ...f,
    concurrency: 1,
    runUntil: 100,
    now: () => clock,
    processJob: async () => {
      clock = 101;
      return 'completed';
    },
  });
  assert.deepEqual(result, { processed: 1, failed: false });
  assert.equal(f.claims.length, 1);
});
