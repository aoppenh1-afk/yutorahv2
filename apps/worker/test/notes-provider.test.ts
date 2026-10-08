import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { NotesStore } from '../../../packages/transcription/src/notes-store.js';
import {
  TranscriptionStore,
  profile,
} from '../../../packages/transcription/src/store.js';
import { notesProfile } from '../../../packages/transcription/src/notes.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';
import { digest } from '../../../packages/transcription/src/fingerprint.js';
import {
  FREE_NOTES_MODEL,
  openCodeIdentity,
} from '../../../packages/opencode-acp/src/runtime.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import {
  processNotesJob,
  runLeasedJob,
  runtimeIdentity,
} from '../src/worker.js';
import { runNotesWorker, type NotesWorkerStatus } from '../src/notes-worker.js';
import { workWake } from '../../../packages/transcription/src/work-wake.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
void test(
  'OpenCode notes queue routing, provider migration, persistence and throttling',
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 30000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'notes-provider-db-'));
    const schema = 'notes_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
      max: 8,
    });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    });
    for (const file of (await readdir('db/transcription'))
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .sort())
      await pool.query(await readFile(join('db/transcription', file), 'utf8'));
    const store = new TranscriptionStore(pool);
    const notes = new NotesStore(pool);
    const transcriptionSkill = 'Complete transcription contract';
    const notesSkill = 'Complete lecture notes contract';
    const transcription = profile(
      transcriptionSkill,
      defaultSettings,
      runtimeIdentity(),
    );
    const source = 'The גמ׳ introduces חזרה and the student asks about רש״י.';
    const validNotes =
      '# דין חזרה\n\n## The גמ׳\n\n- **גמ׳:** introduces חזרה\n    - **Student:** asks about רש״י';
    const publish = async (id: string) => {
      await store.enqueue(
        { id, title: 'דין חזרה', teacher: 'Rabbi Fixture' },
        transcription,
      );
      const job = await store.claim();
      assert.ok(job);
      await store.manifest(job, digest('audio'), digest('audio'), {
        version: 1,
        durationMs: 10000,
        ranges: [{ start: 0, end: 10, coreStart: 0, coreEnd: 10 }],
      });
      await store.complete(job, {
        schemaVersion: 1,
        durationMs: 10000,
        text: source,
        segments: [
          {
            startMs: 1000,
            endMs: 10000,
            text: source,
            speaker: 'Rabbi',
            language: null,
          },
        ],
      });
    };
    const executable = join(root, 'opencode');
    const writeExecutable = async (behavior = 'normal') =>
      writeFile(
        executable,
        `#!/bin/sh\nexport OPENCODE_FIXTURE_BEHAVIOR=${quote(behavior)}\nexec ${quote(process.execPath)} ${quote(resolve('apps/worker/test/fixtures/opencode.mjs'))} "$@"\n`,
        { mode: 0o700 },
      );
    await writeExecutable();
    const openCode = { executable, scratch: join(root, 'notes-scratch') };
    const legacy = notesProfile({
      model: defaultSettings.model,
      language: 'hebrewEnglish',
      runtime: runtimeIdentity(),
      transcriptionSkill,
      notesSkill,
    });
    const pinned = notesProfile({
      model: FREE_NOTES_MODEL,
      language: 'hebrewEnglish',
      runtime: openCodeIdentity(openCode),
      transcriptionSkill,
      notesSkill,
    });
    const config = {
      runtime: {
        directory: join(root, 'missing-google'),
        profile: root,
        scratch: join(root, 'google-scratch'),
      },
      openCode,
      notes: pinned,
      concurrency: 1,
      pollMs: 50,
    };
    await t.test(
      'provider switch preserves completed notes and moves only pending jobs',
      async () => {
        await publish('41');
        await publish('42');
        await notes.enqueueMissing(legacy);
        const first = await notes.claim(false, runtimeIdentity());
        assert.ok(first);
        await notes.complete(first, validNotes);
        await notes.enqueueMissing(pinned);
        const states = (
          await pool.query(
            'SELECT j.status,v.runtime FROM notes_jobs j JOIN notes_versions v ON v.id=j.version_id ORDER BY j.created_at',
          )
        ).rows;
        assert.deepEqual(
          states.map((r) => r.status),
          ['completed', 'queued'],
        );
        assert.equal(states[0].runtime, runtimeIdentity());
        assert.equal(states[1].runtime, pinned.runtime);
        assert.equal(
          await notes.claim(false, runtimeIdentity()),
          null,
          'Google must not admit OpenCode jobs',
        );
        const job = await notes.claim(false, 'opencode:');
        assert.ok(job);
        await runLeasedJob(notes, job, new AbortController().signal, (s) =>
          processNotesJob(notes, job, config, s),
        );
        assert.equal(
          (
            await pool.query(
              'SELECT markdown FROM transcript_notes WHERE id=$1',
              [job.id],
            )
          ).rows[0].markdown,
          validNotes,
        );
        assert.deepEqual(await readdir(openCode.scratch), []);
        const revision = workWake(pool).revision;
        await notes.enqueueMissing(pinned);
        assert.equal(
          workWake(pool).revision,
          revision,
          'a no-op scan must not wake itself indefinitely',
        );
      },
    );
    await t.test(
      'live legacy leases retain their original provider',
      async () => {
        await publish('43');
        await notes.enqueueMissing(legacy);
        const active = await notes.claim(false, runtimeIdentity());
        assert.ok(active);
        await notes.enqueueMissing(pinned);
        assert.equal(
          (
            await pool.query('SELECT version_id FROM notes_jobs WHERE id=$1', [
              active.id,
            ])
          ).rows[0].version_id,
          legacy.id,
        );
        await notes.finishFailure(active, 'cancelled', true);
        await notes.enqueueMissing(pinned);
      },
    );
    await t.test(
      'runtime upgrades move queued OpenCode jobs without regenerating completed notes',
      async () => {
        const old = notesProfile({
          model: FREE_NOTES_MODEL,
          language: 'hebrewEnglish',
          runtime: 'opencode:2.0.24:notes-1',
          transcriptionSkill,
          notesSkill,
        });
        await notes.enqueueMissing(old);
        assert.equal(
          (
            await pool.query(
              "SELECT version_id FROM notes_jobs WHERE status='queued'",
            )
          ).rows[0].version_id,
          old.id,
        );
        await notes.enqueueMissing(pinned);
        assert.equal(
          (
            await pool.query(
              "SELECT version_id FROM notes_jobs WHERE status='queued'",
            )
          ).rows[0].version_id,
          pinned.id,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM notes_jobs WHERE status='completed'",
            )
          ).rows[0].count,
          2,
        );
      },
    );
    await t.test(
      'OpenCode quota is requeued with a durable delay and never triggers Google quota handling',
      async () => {
        await writeExecutable('quota');
        let googleQuotaCalls = 0;
        const controller = new AbortController();
        let report!: (status: NotesWorkerStatus) => void;
        const waiting = new Promise<NotesWorkerStatus>((resolve) => {
          report = resolve;
        });
        const work = runNotesWorker(
          store,
          {
            ...config,
            onQuotaExhausted: () => googleQuotaCalls++,
            onStatus: (s) => {
              if (s.state === 'waiting_quota') report(s);
            },
          },
          controller.signal,
        );
        const status = await waiting;
        assert.equal(status.error, 'quota_exhausted');
        assert.ok(status.resumeAt);
        const job = (
          await pool.query(
            "SELECT status,available_at>now() AS delayed FROM notes_jobs WHERE status='queued'",
          )
        ).rows[0];
        assert.equal(job.status, 'queued');
        assert.equal(job.delayed, true);
        assert.equal(await notes.claim(false, 'opencode:'), null);
        assert.equal(googleQuotaCalls, 0);
        controller.abort(new Failure('cancelled'));
        await assert.rejects(work, { code: 'cancelled' });
      },
    );
  },
);
