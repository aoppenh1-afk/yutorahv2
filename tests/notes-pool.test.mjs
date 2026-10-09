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

void test('six distinct transcripts run concurrently and a freed slot refills immediately', async () => {
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

void test('bounded pilots never claim more jobs than their limit', async () => {
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

void test('invalid transcripts are blocked and freed lanes claim immediately', async () => {
  const f = fixture(7);
  const gates = new Map();
  const waits = [];
  const run = runNotesPool({
    ...f,
    sleep: (ms) => {
      waits.push(ms);
      assert.equal(
        ms,
        0,
        'A permanent failure must never cool down other lanes.',
      );
      return nextTurn();
    },
    processJob: (job) =>
      new Promise((resolve, reject) => gates.set(job.id, { resolve, reject })),
  });
  await until(() => gates.size === 6);
  gates.get('1').reject(
    Object.assign(new Error('Malformed WebVTT cue.'), {
      code: 'invalid_transcript',
    }),
  );
  await until(() => f.blocked.length || f.retries.length);
  await until(() => gates.has('7') || f.retries.length);
  for (const gate of gates.values()) gate.resolve('completed');
  gates.get('7')?.resolve('completed');
  const result = await run;
  assert.deepEqual(f.blocked, [['1', 'invalid_transcript']]);
  assert.deepEqual(f.retries, []);
  assert.deepEqual(result, { processed: 7, failed: false });
  assert.equal(
    f.events.find((e) => e.status === 'blocked').message,
    'Malformed WebVTT cue.',
  );
});

void test('ordinary errors back off just the failing job in a following pool', async () => {
  const f = fixture(7);
  const gates = new Map();
  const run = runNotesPool({
    ...f,
    follow: true,
    limit: 6,
    sleep: async (ms) => {
      assert.equal(ms, 0, 'An ordinary error must not set a shared cooldown.');
      await nextTurn();
    },
    processJob: (job) =>
      new Promise((resolve, reject) => gates.set(job.id, { resolve, reject })),
  });
  await until(() => gates.size === 6);
  gates.get('1').reject(new Error('Upstream HTTP 500'));
  await until(() => f.retries.length === 1);
  for (const gate of gates.values()) gate.resolve('completed');
  await until(() => gates.has('7'));
  gates.get('7').resolve('completed');
  assert.deepEqual(await run, { processed: 6, failed: false });
  assert.deepEqual(f.retries, [['1', 'processing_failed', 120000]]);
  assert.equal(
    f.events.find((e) => e.status === 'retry').message,
    'Upstream HTTP 500',
  );
});

void test('quota errors cool down all new work while allowing active jobs to finish', async () => {
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

/** @type {Array<[string, { status: number, retryAfter?: string, retryAfterMs?: number }]>} */
const cooldownCases = [
  ['HTTP 429', { status: 429 }],
  ['HTTP 503', { status: 503 }],
  ['Retry-After', { status: 502, retryAfter: '180', retryAfterMs: 180000 }],
];
for (const [name, details] of cooldownCases)
  void test(`${name} pauses new claims across lanes`, async () => {
    const f = fixture(3);
    let clock = 0;
    const starts = [];
    const result = await runNotesPool({
      ...f,
      concurrency: 1,
      follow: true,
      limit: 2,
      now: () => clock,
      sleep: async (ms) => {
        await nextTurn();
        clock += ms;
      },
      processJob: async (job) => {
        starts.push(clock);
        if (job.id === '1') throw Object.assign(new Error(name), details);
        return 'completed';
      },
    });
    assert.equal(result.processed, 2);
    assert.ok(starts[1] >= (details.retryAfterMs ?? 120000));
  });

void test('abort drains every active session before returning and stops claiming', async () => {
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

void test('a bounded pilot reports retries and drains the remaining jobs; conflicts are blocked', async () => {
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

void test('an ordinary failure also lets a bounded pilot fill its next lane', async () => {
  const f = fixture(8);
  const result = await runNotesPool({
    ...f,
    concurrency: 1,
    limit: 3,
    processJob: async (job) => {
      if (job.id === '1') throw new Error('Upstream HTTP 500');
      return 'completed';
    },
    sleep: async (ms) => assert.equal(ms, 0),
  });
  assert.deepEqual(result, { processed: 2, failed: true });
  assert.deepEqual(f.claims, ['1', '2', '3']);
});

void test('error messages are bounded, single-line, and redact credentials before truncation', async () => {
  const f = fixture(1);
  await runNotesPool({
    ...f,
    secrets: ['private-value'],
    processJob: async () => {
      throw Object.assign(
        new Error(
          'Malformed cue: private-value\npassword="another-value" Authorization: Bearer third-value https://user:pass@example.com/?token=fourth-value ' +
            'x'.repeat(400),
        ),
        { code: 'invalid_transcript' },
      );
    },
  });
  const event = f.events.find((e) => e.status === 'blocked');
  assert.equal(event.message.length, 300);
  assert.match(event.message, /Malformed cue/);
  assert.doesNotMatch(
    event.message,
    /private-value|another-value|third-value|fourth-value|user:pass|\n/,
  );
});

void test('the scheduling deadline stops new claims and drains in-flight jobs', async () => {
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
