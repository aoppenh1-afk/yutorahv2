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

void test('source-aware normalization removes unwanted prose vowel marks while preserving quoted source text and consonants', async () => {
  const raw =
    '# טְבִילָה\n\n## The distinction\n\nWe explain טְבִילָה through the supported quotation “בְּרֵאשִׁית”. This distinction resolves the שאלה.';
  const source =
    'We discuss טבילה and the quotation בְּרֵאשִׁית and answer the שאלה.';
  const expected =
    '# טבילה\n\n## The distinction\n\nWe explain טבילה through the supported quotation “בְּרֵאשִׁית”. This distinction resolves the שאלה.';
  assert.equal(normalizeNotes(raw, source), expected);
  const marks = /[\u0591-\u05bd\u05bf\u05c1-\u05c2\u05c4-\u05c5\u05c7]/g;
  assert.equal(expected.replace(marks, ''), raw.replace(marks, ''));
  assert.equal(normalizeNotes(expected, source), expected);
  let calls = 0;
  const result = await generateNotes({
    profile: notesProfile({
      model: 'free',
      runtime: 'test',
      language: 'hebrewEnglish',
      notesSkill: 'Connected English prose; unvocalized terms.',
    }),
    source,
    signal: AbortSignal.timeout(1000),
    request: async () => {
      calls++;
      return raw;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.markdown, expected);
});

void test('normalization never rewrites a quoted vocalized passage to make an unsupported quotation pass', () => {
  const raw =
    '# שאלה\n\n## Argument\n\nWe preserve the quoted wording “בְּרֵאשִׁית” for source checking.';
  assert.equal(normalizeNotes(raw, 'An unrelated transcript.'), raw);
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

void test('memory admission distinguishes allocated sessions from pending startup allocations', async (t) => {
  for (const scenario of [
    { memory: 3659, output: 'current', expected: 4 },
    { memory: 3659, output: 'none', expected: 1 },
    { memory: 3583, output: 'current', expected: 0 },
    { memory: 4096, output: 'none', expected: 2 },
    { memory: 3659, output: 'old-lease', expected: 1 },
    { memory: 3659, output: 'previous-request', expected: 1 },
    { memory: 3659, output: 'current', dropAfter: 2, expected: 2 },
  ]) {
    const queue = new NotesQueue(':memory:');
    t.after(() => queue.close());
    queue.enqueue(Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1) })));
    for (let i = 0; i < 4; i++) {
      const job = queue.claim('fetching')!;
      queue.finish(job, {
        status: 'ready',
        eligibility: 'eligible',
        source_path: 'sources/fixture.vtt',
        source_bytes: 100,
      });
    }
    let launched = 0;
    await runCoordinator({
      root: '.',
      queue,
      pipeline: {
        recoverExpired: async () => {},
        fetching: async () => assert.fail('Fetch pool is disabled'),
        publishing: async () => assert.fail('Publish pool is disabled'),
        generating: async (job, signal) => {
          launched++;
          queue.db
            .prepare(`INSERT INTO requests
            (id,job_id,token,route,kind,started_at,status,reserved_tokens)
            VALUES(?,?,?,'server-high','generation',?,'active',1)`)
            .run(job.id, job.id, job.lease_token, Date.now());
          if (scenario.output === 'current')
            queue.observe(job.id, 'first_output', 1);
          if (scenario.output === 'old-lease') {
            queue.db
              .prepare(`INSERT INTO requests
              (id,job_id,token,route,kind,started_at,status,reserved_tokens)
              VALUES(?,?,?,'server-high','generation',?,'active',1)`)
              .run(
                job.id + '-old',
                job.id,
                job.lease_token + '-old',
                Date.now(),
              );
            queue.observe(job.id + '-old', 'first_output', 1);
          }
          if (scenario.output === 'previous-request') {
            queue.observe(job.id, 'first_output', 1);
            queue.db
              .prepare(
                "UPDATE requests SET status='completed',ended_at=? WHERE id=?",
              )
              .run(Date.now(), job.id);
            queue.db
              .prepare(`INSERT INTO requests
              (id,job_id,token,route,kind,started_at,status,reserved_tokens)
              VALUES(?,?,?,'server-high','repair',?,'active',1)`)
              .run(job.id + '-repair', job.id, job.lease_token, Date.now());
          }
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
          return 'generated';
        },
      },
      settings: { ...defaults, fetchers: 0, publishers: 0 },
      signal: AbortSignal.timeout(250),
      follow: true,
      memory: async () =>
        launched >= (scenario.dropAfter ?? Infinity) ? 3000 : scenario.memory,
      disk: async () => 100 * 1024 ** 3,
    });
    assert.equal(launched, scenario.expected, JSON.stringify(scenario));
  }
});
