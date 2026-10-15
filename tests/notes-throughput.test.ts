import test from 'node:test';
import assert from 'node:assert/strict';
import { NotesQueue } from '../packages/notes-only/src/queue.js';
import { InferenceLimiter } from '../packages/notes-only/src/control.js';
import {
  generateNotes,
  normalizeNotes,
  notesProfile,
} from '../packages/notes-only/src/notes.js';
import {
  defaults,
  runCoordinator,
} from '../packages/notes-only/src/coordinator.js';
import { NotesPipeline } from '../packages/notes-only/src/pipeline.js';

function fixture(t: test.TestContext) {
  const queue = new NotesQueue(':memory:');
  t.after(() => queue.close());
  queue.enqueue([{ id: '1' }]);
  const job = queue.claim('fetching')!;
  const limiter = new InferenceLimiter(queue, {
    concurrency: 4,
    spacingMs: 0,
    requestsPerMinute: 30,
    tokensPerMinute: 1000,
    outputReservation: 700,
  });
  const evidence = {
    input: 10,
    output: 10,
    reasoning: 5,
    cacheRead: 2,
    cacheWrite: 1,
    cost: 0,
    identity: 'free',
  };
  return { queue, job, limiter, evidence };
}

void test('presentation normalization avoids full repair and preserves Hebrew, quotation text, and word order', async () => {
  const raw =
    '# שאלה  \r\n## Argument\r\nThe phrase “בְּרֵאשִׁית” stays quoted.\r\n';
  const expected = '# שאלה\n\n## Argument\n\nThe phrase “בְּרֵאשִׁית” stays quoted.';
  assert.equal(normalizeNotes(raw), expected);
  assert.equal(normalizeNotes(expected), expected);
  assert.equal(normalizeNotes(raw).replace(/\s/g, ''), raw.replace(/\s/g, ''));
  let calls = 0;
  const result = await generateNotes({
    profile: notesProfile({
      model: 'free',
      runtime: 'test',
      language: 'hebrewEnglish',
      notesSkill: 'Connected prose.',
    }),
    source: 'The phrase בְּרֵאשִׁית',
    signal: new AbortController().signal,
    request: async () => {
      calls++;
      return raw;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.markdown, expected);
});

void test('completed known usage releases the unused reservation for another full-source request', async (t) => {
  const { queue, job, limiter, evidence } = fixture(t);
  await limiter.run(
    job,
    'server-high',
    'generation',
    'prompt',
    AbortSignal.timeout(1000),
    async () => ({ value: 'ok', evidence }),
  );
  await limiter.run(
    job,
    'server-high',
    'repair',
    'full repair',
    AbortSignal.timeout(150),
    async () => ({ value: 'ok', evidence }),
  );
  assert.equal(
    queue.db
      .prepare("SELECT COUNT(*) n FROM requests WHERE status='completed'")
      .get()?.n,
    2,
  );
});

void test('an active request older than a minute still consumes budget and an inference slot', async (t) => {
  const { queue, job, limiter, evidence } = fixture(t);
  queue.db
    .prepare(
      "INSERT INTO requests(id,job_id,token,route,kind,started_at,status,reserved_tokens) VALUES('old',?,?, 'server-high','generation',?,'active',900)",
    )
    .run(job.id, job.lease_token, Date.now() - 120000);
  await assert.rejects(
    limiter.run(
      job,
      'server-high',
      'generation',
      'prompt',
      AbortSignal.timeout(50),
      async () => {
        assert.fail('Old in-flight work vanished from the budget');
        return { value: 'bad', evidence };
      },
    ),
  );
  assert.equal(queue.db.prepare('SELECT COUNT(*) n FROM requests').get()?.n, 1);
});

void test('quarantined evidence does not masquerade as publishable outbox work', (t) => {
  const { queue, job } = fixture(t);
  queue.finish(job, { status: 'needs_review', error: 'incomplete_output' });
  const usage = queue.usage();
  assert.equal(usage.outboxCount, 0);
  assert.equal(usage.quarantineCount, 1);
});

void test('a generated artifact with revoked review is quarantined rather than advertised as publishable', (t) => {
  const { queue, job } = fixture(t);
  queue.finish(job, {
    status: 'generated',
    review: 'rejected',
    artifact_bytes: 256,
  });
  const usage = queue.usage();
  assert.equal(usage.outboxCount, 0);
  assert.equal(usage.quarantineCount, 1);
  assert.equal(usage.quarantineBytes, 256);
  assert.equal(queue.claim('publishing'), null);
});

void test('all admission entry points reject more than six AI workers', async (t) => {
  const { queue } = fixture(t);
  assert.throws(
    () =>
      new InferenceLimiter(queue, {
        concurrency: 7,
        spacingMs: 0,
        requestsPerMinute: 30,
        tokensPerMinute: 1000,
        outputReservation: 100,
      }),
    /concurrency|six|6/i,
  );
  await assert.rejects(
    runCoordinator({
      root: '.',
      queue,
      pipeline: {} as NotesPipeline,
      settings: { ...defaults, generators: 7 },
      signal: new AbortController().signal,
    }),
    /bounds|six|6/i,
  );
});

void test('recovery lookups use bounded live-state indexes', (t) => {
  const { queue } = fixture(t);
  for (const sql of [
    "SELECT id FROM sessions WHERE job_id='1' AND runtime='server' AND state!='deleted'",
    "SELECT id FROM sessions WHERE state='active'",
    "SELECT id FROM requests WHERE job_id='1' AND status='active'",
    "SELECT * FROM generation_artifacts WHERE job_id='1' ORDER BY created_at DESC",
  ]) {
    const plan = queue.db
      .prepare('EXPLAIN QUERY PLAN ' + sql)
      .all()
      .map((r) => r.detail)
      .join(' ');
    assert.match(plan, /USING INDEX|USING COVERING INDEX/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  }
});
