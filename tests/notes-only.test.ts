import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { NotesQueue } from '../packages/notes-only/src/queue.js';
import { NotesPipeline } from '../packages/notes-only/src/pipeline.js';
import {
  importLegacy,
  loadArtifact,
  durableWrite,
} from '../packages/notes-only/src/artifacts.js';
import {
  defaults,
  runCoordinator,
  OUTBOX_RESERVATION,
} from '../packages/notes-only/src/coordinator.js';
import { backupArtifacts } from '../packages/notes-only/src/backup.js';
import {
  packNote,
  unpackNote,
  type SavedNote,
} from '../lib/tidb-notes-store.js';
import {
  generateNotes,
  notesProfile,
  notesViolations,
} from '../packages/notes-only/src/notes.js';
import {
  InferenceLimiter,
  retryAfter,
} from '../packages/notes-only/src/control.js';
import { beginRegeneration } from '../packages/notes-only/src/regeneration.js';
import { priorityInventoryPage } from '../packages/notes-only/src/inventory.js';
const vtt =
  'WEBVTT\n\n00:02.000 --> 00:04.000\nLater סוף\n\n00:01.000 --> 00:03.000\nEarlier ראשית\n';
const markdown =
  '# שאלה\n\n## The argument\n\nWe begin with the שאלה. The first distinction explains its consequence. The final qualification remains unresolved.';
const identity = {
  profile: 'a'.repeat(64),
  generator: 'full immutable contract identity',
  route: 'acp-high' as const,
  approved: true,
};
const signal = new AbortController().signal;
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'staged-notes-'));
  const queue = new NotesQueue(join(root, 'queue.sqlite'));
  t.after(async () => {
    queue.close();
    await rm(root, { recursive: true, force: true });
  });
  const notes = new Map<string, SavedNote>();
  let calls = 0;
  const pipeline = new NotesPipeline({
    root,
    queue,
    identity,
    store: {
      get: async (id) => notes.get(id) ?? null,
      publish: async (note) => {
        notes.set(note.shiurId, note);
        return note;
      },
    },
    fetchTranscript: async () => vtt,
    reconcileRuntime: async () => {},
    generate: async (source) => {
      calls++;
      assert.equal(source, 'Earlier ראשית\n\nLater סוף');
      return markdown;
    },
  });
  return {
    root,
    queue,
    pipeline,
    notes,
    get calls() {
      return calls;
    },
  };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>, id = '1') {
  f.queue.enqueue([{ id }]);
  await f.pipeline.fetching(f.queue.claim('fetching')!, signal);
}
void test('regeneration archives original completions, never reimports retired notes, and keeps old published content until fresh generation finishes', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.pipeline.generating(f.queue.claim('generating')!, signal);
  await f.pipeline.publishing(f.queue.claim('publishing')!, signal);
  const original = f.notes.get('1')!;
  const oldPath = String(
    f.queue.db.prepare("SELECT artifact_path FROM jobs WHERE id='1'").get()
      ?.artifact_path,
  );
  await writeFile(join(f.root, 'paused'), '');
  f.queue.db
    .prepare("UPDATE jobs SET teacher='Rabbi Aryeh Lebowitz' WHERE id='1'")
    .run();
  const record = await beginRegeneration(
    f.root,
    f.queue,
    [{ id: 80714, name: 'Rabbi Aryeh Lebowitz' }],
    'Regenerate all notes and prioritize these teachers.',
  );
  assert.equal(record.originalCompleted, 1);
  assert.equal(
    (await loadArtifact(f.root, oldPath)).note.notesHash,
    original.notesHash,
  );
  const snapshot = new DatabaseSync(join(record.archive, 'queue.sqlite'), {
    readOnly: true,
  });
  assert.equal(
    snapshot.prepare("SELECT notes_hash FROM jobs WHERE id='1'").get()
      ?.notes_hash,
    original.notesHash,
  );
  snapshot.close();
  assert.equal(await importLegacy(f.root, f.queue), 0);
  assert.equal(
    f.queue.db.prepare("SELECT status FROM jobs WHERE id='1'").get()?.status,
    'discovered',
  );
  await assert.rejects(
    beginRegeneration(
      f.root,
      f.queue,
      [{ id: 80714, name: 'Rabbi Aryeh Lebowitz' }],
      'Repeat',
    ),
    /already configured/,
  );
  const pipeline = new NotesPipeline({
    ...f.pipeline.config,
    regenerationStartedAt: record.startedAt,
  });
  await pipeline.fetching(f.queue.claim('fetching')!, signal);
  assert.equal(f.notes.get('1')!.notesHash, original.notesHash);
  assert.equal(
    f.queue.db.prepare("SELECT replace_hash FROM jobs WHERE id='1'").get()
      ?.replace_hash,
    original.notesHash,
  );
  await pipeline.generating(f.queue.claim('generating')!, signal);
  assert.equal(f.calls, 2, 'the old publication did not skip fresh inference');
  assert.equal(f.notes.get('1')!.createdAtMs, original.createdAtMs);
  await pipeline.publishing(f.queue.claim('publishing')!, signal);
  assert.ok(f.notes.get('1')!.createdAtMs >= record.startedAt);
});

void test('priority teacher inventory resumes each filtered cursor, promotes existing jobs, and takes precedence even on backlog claims', async (t) => {
  const f = await fixture(t);
  f.queue.enqueue([
    { id: '1', teacher: 'Other teacher' },
    { id: '2', teacher: 'Old display name' },
  ]);
  const teachers = [
    { id: 80714, name: 'Rabbi Aryeh Lebowitz' },
    { id: 80002, name: 'Rabbi Elchanan Adler' },
  ];
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    requested.push(url.searchParams.get('teacherID')!);
    const teacher = teachers.find(
      (x) => String(x.id) === url.searchParams.get('teacherID'),
    )!;
    return Response.json({
      response: {
        numFound: 2,
        docs: [
          {
            shiurid: teacher.id === 80714 ? '2' : '3',
            shiurtitle: 'Fresh title',
            teacherfullname: teacher.name,
            teacherid: teacher.id,
          },
          {
            shiurid: '4',
            shiurtitle: 'Unrelated search hit',
            teacherfullname: 'Other teacher',
            teacherid: 999,
          },
        ],
      },
    });
  });
  await priorityInventoryPage(f.queue, signal, teachers);
  await priorityInventoryPage(f.queue, signal, teachers);
  assert.deepEqual(requested, ['80714', '80002']);
  assert.equal(f.queue.cursor('teacherDone:80714'), 1);
  assert.equal(
    f.queue.db.prepare("SELECT 1 FROM jobs WHERE id='4'").get(),
    undefined,
  );
  assert.equal(
    f.queue.db.prepare("SELECT teacher_id FROM jobs WHERE id='2'").get()
      ?.teacher_id,
    80714,
  );
  assert.equal(f.queue.claim('fetching', { backlog: true })?.id, '2');
  assert.equal(f.queue.claim('fetching', { backlog: true })?.id, '3');
  assert.equal(f.queue.claim('fetching', { backlog: true })?.id, '1');
});
void test('atomic claims, lease fencing, stale completion, and renewal across SQLite connections', async (t) => {
  const f = await fixture(t);
  f.queue.enqueue([{ id: '1' }]);
  const other = new NotesQueue(join(f.root, 'queue.sqlite'));
  t.after(() => other.close());
  const first = f.queue.claim('fetching', { now: 10, leaseMs: 10 })!;
  assert.equal(other.claim('fetching', { now: 11 }), null);
  assert.equal(other.renew(first, 10, 21), false);
  const recovered = f.queue.fence(first)!;
  assert.throws(() => f.queue.finish(first, { status: 'ready' }), /lease_lost/);
  f.queue.finish(recovered, { status: 'discovered' });
  assert.notEqual(other.claim('fetching')!.lease_token, first.lease_token);
});
void test('opening a queue never resets live work; migration preserves completion hashes and attempts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'queue.sqlite');
  const old = new DatabaseSync(path);
  old.exec(
    "CREATE TABLE jobs(id TEXT PRIMARY KEY,title TEXT NOT NULL,teacher TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,notes_hash TEXT);INSERT INTO jobs(id,title,teacher,status,attempts,notes_hash) VALUES('1','title','teacher','completed',7,'old-hash'),('2','title','teacher','running',3,NULL)",
  );
  old.close();
  const q = new NotesQueue(path);
  t.after(() => q.close());
  assert.equal(
    q.db.prepare("SELECT notes_hash FROM jobs WHERE id='1'").get()?.notes_hash,
    'old-hash',
  );
  assert.equal(
    q.db.prepare("SELECT attempts FROM jobs WHERE id='1'").get()?.attempts,
    7,
  );
  assert.equal(q.expired().length, 1);
  q.enqueue([{ id: '3' }]);
  const active = q.claim('fetching')!;
  const reopened = new NotesQueue(path);
  assert.equal(
    reopened.expired().some((j) => j.id === active.id),
    false,
  );
  reopened.close();
});
void test('generation commits an immutable artifact; publication retries and restart reuse it without inference', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.pipeline.generating(f.queue.claim('generating')!, signal);
  assert.equal(f.calls, 1);
  const job = f.queue.claim('publishing')!;
  const pipeline = new NotesPipeline({
    ...f.pipeline.config,
    store: {
      get: async () => null,
      publish: async () => {
        throw new Error('TiDB outage');
      },
    },
  });
  await assert.rejects(pipeline.publishing(job, signal), /outage/);
  f.queue.db.prepare("UPDATE jobs SET lease_until=0 WHERE id='1'").run();
  await f.pipeline.recoverExpired();
  await f.pipeline.publishing(f.queue.claim('publishing')!, signal);
  assert.equal(f.calls, 1);
  assert.equal(await unpackNote(f.notes.get('1')!), markdown);
});
void test('a still-running stale generation leaves only an orphan; recovery adopts the matching crash artifact', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const first = f.queue.claim('generating')!;
  const pipeline = new NotesPipeline({
    ...f.pipeline.config,
    generate: async () => {
      f.queue.db.prepare("UPDATE jobs SET lease_until=0 WHERE id='1'").run();
      return markdown;
    },
  });
  await assert.rejects(pipeline.generating(first, signal), /lease_lost/);
  assert.equal(
    f.queue.db.prepare("SELECT artifact_path FROM jobs WHERE id='1'").get()
      ?.artifact_path,
    null,
  );
  await f.pipeline.recoverExpired();
  const current = f.queue.claim('publishing')!;
  assert.ok(current.artifact_path);
  await f.pipeline.publishing(current, signal);
  assert.equal(f.calls, 0);
});
void test('crash before the manifest commits requests a fresh attempt, while accepted corruption stops recovery', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const first = f.queue.claim('generating')!;
  f.queue.db
    .prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)')
    .run(
      first.lease_token,
      first.id,
      first.source_hash,
      identity.profile,
      'artifacts/missing',
      Date.now(),
    );
  f.queue.db.prepare("UPDATE jobs SET lease_until=0 WHERE id='1'").run();
  await f.pipeline.recoverExpired();
  await f.pipeline.generating(f.queue.claim('generating')!, signal);
  const job = f.queue.claim('publishing')!;
  await writeFile(join(f.root, job.artifact_path!, 'notes.md.gz'), 'corrupt');
  f.queue.db.prepare("UPDATE jobs SET lease_until=0 WHERE id='1'").run();
  await assert.rejects(f.pipeline.recoverExpired(), /manifest/);
});
void test('published hash conflicts remain explicit and preserve the accepted artifact', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.pipeline.generating(f.queue.claim('generating')!, signal);
  const other = await packNote({
    shiurId: '1',
    sourceHash: 'b'.repeat(64),
    generatorVersion: 'old',
    language: 'hebrewEnglish',
    markdown: '# Other\n\nPublished note.',
  });
  const pipeline = new NotesPipeline({
    ...f.pipeline.config,
    store: { get: async () => null, publish: async () => other },
  });
  const job = f.queue.claim('publishing')!;
  assert.equal(await pipeline.publishing(job, signal), 'conflict');
  assert.equal(
    (await loadArtifact(f.root, job.artifact_path!)).note.notesHash,
    job.notes_hash,
  );
  assert.equal(f.queue.claim('publishing'), null);
});
void test('unknown TiDB eligibility can stage a source but cannot reach inference; missing differs from transient failure', async (t) => {
  const f = await fixture(t);
  f.queue.enqueue([{ id: '1' }]);
  const p = new NotesPipeline({
    ...f.pipeline.config,
    store: {
      get: async () => {
        throw new Error('outage');
      },
      publish: f.pipeline.config.store.publish,
    },
  });
  await p.fetching(f.queue.claim('fetching')!, signal);
  assert.equal(f.queue.claim('generating'), null);
  assert.ok(
    f.queue.db.prepare("SELECT source_path FROM jobs WHERE id='1'").get()
      ?.source_path,
  );
  f.queue.enqueue([{ id: '2' }]);
  const missing = new NotesPipeline({
    ...f.pipeline.config,
    fetchTranscript: async () => null,
  });
  await missing.fetching(f.queue.claim('fetching')!, signal);
  assert.equal(
    f.queue.db.prepare("SELECT status FROM jobs WHERE id='2'").get()?.status,
    'missing',
  );
  f.queue.enqueue([{ id: '3' }]);
  const transient = new NotesPipeline({
    ...f.pipeline.config,
    fetchTranscript: async () => {
      throw new Error('network');
    },
  });
  await assert.rejects(
    transient.fetching(f.queue.claim('fetching')!, signal),
    /network/,
  );
});
void test('candidate notes stay local and a prose repair includes the complete final cue', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const p = new NotesPipeline({
    ...f.pipeline.config,
    identity: { ...identity, route: 'server-high', approved: false },
  });
  await p.generating(f.queue.claim('generating')!, signal);
  assert.equal(f.queue.claim('publishing'), null);
  const skill = await readFile(
    'packages/notes-only/skills/written-shiur-notes/SKILL.md',
    'utf8',
  );
  const profile = notesProfile({
    model: 'free',
    runtime: 'test',
    language: 'hebrewEnglish',
    notesSkill: skill,
  });
  let requests = 0;
  const result = await generateNotes({
    profile,
    source: 'Beginning שאלה\n\nFinal substantive cue',
    signal,
    request: async (prompt, kind) => {
      assert.match(prompt, /Final substantive cue/);
      requests++;
      return kind === 'generation'
        ? '# שאלה\n\n## Argument\n\n- outline'
        : markdown;
    },
  });
  assert.equal(requests, 2);
  assert.equal(result.markdown, markdown);
  assert.deepEqual(notesViolations(markdown, 'שאלה'), []);
});
void test('bounded concurrent pilots never exceed their ID limit and refill stages independently', async (t) => {
  const f = await fixture(t);
  f.queue.enqueue(
    Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1) })),
  );
  const result = await runCoordinator({
    root: f.root,
    queue: f.queue,
    pipeline: f.pipeline,
    settings: { ...defaults, minFreeMemoryMiB: 0 },
    signal,
    limit: 3,
    disk: async () => 100 * 1024 ** 3,
  });
  assert.equal(result.selected, 3);
  assert.equal(result.finished, 3);
  assert.equal(f.notes.size, 3);
  assert.equal(f.calls, 3);
});
void test('memory, disk, and outbox reservations stop generation without blocking publication', async (t) => {
  for (const control of ['memory', 'disk', 'outbox']) {
    const f = await fixture(t);
    await ready(f);
    const result = await runCoordinator({
      root: f.root,
      queue: f.queue,
      pipeline: f.pipeline,
      settings: {
        ...defaults,
        outboxBytes:
          control === 'outbox' ? OUTBOX_RESERVATION : defaults.outboxBytes,
        outboxCount: control === 'outbox' ? 0 : 100,
      },
      signal,
      limit: 1,
      memory: async () => (control === 'memory' ? 1 : 10000),
      disk: async () => (control === 'disk' ? 1 : 100 * 1024 ** 3),
    });
    assert.equal(result.selected, 0);
    assert.equal(f.calls, 0);
  }
});
void test('isolated upstream cooldowns, Retry-After dates, and shared repair budget', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const job = f.queue.claim('generating')!;
  f.queue.cooldown('tidb', 60000, 'throttled');
  assert.equal(f.queue.available('muse'), true);
  assert.equal(f.queue.available('yutorah'), true);
  assert.equal(retryAfter('2'), 2000);
  assert.equal(
    retryAfter(
      'Wed, 14 Oct 2026 12:00:10 GMT',
      Date.parse('2026-10-14T12:00:00Z'),
    ),
    10000,
  );
  const limiter = new InferenceLimiter(f.queue, {
    concurrency: 1,
    spacingMs: 0,
    requestsPerMinute: 1,
    tokensPerMinute: 10000,
    outputReservation: 100,
  });
  const evidence = {
    input: 1,
    output: 2,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    identity: 'free',
  };
  await limiter.run(
    job,
    'acp-high',
    'generation',
    'full prompt',
    signal,
    async () => ({ value: 'x', evidence }),
  );
  const abort = new AbortController();
  const request = limiter.run(
    job,
    'server-high',
    'repair',
    'full repair',
    abort.signal,
    async () => assert.fail('Budget was bypassed'),
  );
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(request);
  assert.equal(
    f.queue.db.prepare('SELECT COUNT(*) AS count FROM requests').get()?.count,
    1,
  );
});
void test('incremental backup repairs a missing journal entry; corruption and retention checkpoints protect originals', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.pipeline.generating(f.queue.claim('generating')!, signal);
  await f.pipeline.publishing(f.queue.claim('publishing')!, signal);
  f.queue.db.exec('DELETE FROM backup_journal');
  const destination = join(f.root, 'backup');
  const result = await backupArtifacts(f.root, destination, f.queue);
  assert.equal(result.verified, 1);
  assert.equal(
    (await backupArtifacts(f.root, destination, f.queue)).verified,
    0,
  );
  assert.equal(
    (await backupArtifacts(f.root, destination, f.queue, true)).verified,
    1,
  );
  assert.equal(await f.pipeline.reclaim(Date.now() + 2 * 86400_000), 1);
  const row = f.queue.db
    .prepare("SELECT artifact_path FROM jobs WHERE id='1'")
    .get()!;
  await writeFile(
    join(destination, String(row.artifact_path), 'notes.md.gz'),
    'corrupt',
  );
  await assert.rejects(
    backupArtifacts(f.root, destination, f.queue, true),
    /manifest/,
  );
  await loadArtifact(f.root, String(row.artifact_path));
});
void test('legacy import is idempotent and freezes existing provenance without regeneration', async (t) => {
  const f = await fixture(t);
  const note = await packNote({
    shiurId: '1',
    sourceHash: 'c'.repeat(64),
    generatorVersion: 'old-profile',
    language: 'hebrewEnglish',
    markdown,
  });
  const folder = join(f.root, 'notes', '1');
  await mkdir(folder, { recursive: true });
  const { gzip, ...metadata } = note;
  await durableWrite(join(folder, 'notes.md.gz'), gzip);
  await durableWrite(join(folder, 'metadata.json'), JSON.stringify(metadata));
  f.queue.enqueue([{ id: '1' }]);
  f.queue.db
    .prepare(
      "UPDATE jobs SET status='completed',attempts=9,notes_hash=? WHERE id='1'",
    )
    .run(note.notesHash);
  assert.equal(await importLegacy(f.root, f.queue), 1);
  assert.equal(await importLegacy(f.root, f.queue), 0);
  const row = f.queue.db.prepare("SELECT * FROM jobs WHERE id='1'").get()!;
  assert.equal(row.attempts, 9);
  assert.equal(row.notes_hash, note.notesHash);
  assert.equal(row.status, 'completed');
});

void test('actual SIGKILL before/after artifact and SQLite commits preserves recoverable work', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  for (const point of ['before_commit', 'after_commit', 'after_accept']) {
    const f = await fixture(t);
    await assert.rejects(
      run(process.execPath, [
        '--import',
        'tsx',
        'tests/fixtures/crash-notes.ts',
        f.root,
        point,
      ]),
      (error) => (error as { signal?: string }).signal === 'SIGKILL',
    );
    f.queue.db
      .prepare("UPDATE jobs SET lease_until=0 WHERE status='generating'")
      .run();
    await f.pipeline.recoverExpired();
    const row = f.queue.db
      .prepare("SELECT status,artifact_path FROM jobs WHERE id='1'")
      .get()!;
    assert.equal(row.status, point === 'before_commit' ? 'ready' : 'generated');
    if (point !== 'before_commit') {
      await f.pipeline.publishing(f.queue.claim('publishing')!, signal);
      assert.equal(f.calls, 0);
    }
  }
});

void test('a fetch outage respects count and byte reservations while memory admission is closed', async (t) => {
  const f = await fixture(t);
  f.queue.enqueue(
    Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1) })),
  );
  const result = await runCoordinator({
    root: f.root,
    queue: f.queue,
    pipeline: f.pipeline,
    settings: {
      ...defaults,
      readyLow: 0,
      readyTarget: 2,
      readyMax: 2,
      sourceBytes: 8 * 1024 ** 2,
    },
    signal,
    follow: true,
    maxRuntimeMs: 300,
    memory: async () => 0,
    disk: async () => 100 * 1024 ** 3,
  });
  assert.equal(f.calls, 0);
  assert.ok(f.queue.usage().sourceCount <= 2);
  assert.ok(f.queue.usage().sourceBytes <= 8 * 1024 ** 2);
  assert.ok(result.selected <= 2);
});

void test('unexpired generation from a previous coordinator consumes admission capacity until reconciled', async (t) => {
  const f = await fixture(t);
  await ready(f, '1');
  const previous = f.queue.claim('generating')!;
  await ready(f, '2');
  const result = await runCoordinator({
    root: f.root,
    queue: f.queue,
    pipeline: f.pipeline,
    settings: { ...defaults, generators: 1, minFreeMemoryMiB: 0 },
    signal,
    limit: 1,
    disk: async () => 100 * 1024 ** 3,
  });
  assert.equal(result.selected, 0);
  assert.equal(f.calls, 0);
  assert.equal(f.queue.owns(previous), true);
});
