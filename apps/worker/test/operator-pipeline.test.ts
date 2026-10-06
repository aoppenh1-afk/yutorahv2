import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import {
  TranscriptionStore,
  profile,
} from '../../../packages/transcription/src/store.js';
import { NotesStore } from '../../../packages/transcription/src/notes-store.js';
import {
  generateNotes,
  notesProfile,
  notesViolations,
  normalizeNotes,
} from '../../../packages/transcription/src/notes.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';
import { prepareProfile } from '../../../packages/antigravity-acp/src/runtime.js';
import { runProcess } from '../../../packages/antigravity-acp/src/process.js';
import { SessionPool } from '../../../packages/antigravity-acp/src/pool.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import {
  processJob,
  processNotesJob,
  runLeasedJob,
  runtimeIdentity,
  runWorker,
} from '../src/worker.js';
import { SelectionStore, scanSelections } from '../src/selections.js';
import { OperatorRuntime } from '../src/operator-runtime.js';
import { createOperatorServer } from '../src/operator-server.js';
import { createSearchServer } from '../src/search-server.js';
import { GET as websiteContent } from '../../../app/api/transcript/route.js';
import { digest } from '../../../packages/transcription/src/fingerprint.js';

const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const validNotes =
  '# דין חזרה\n\n## The גמ׳\n\n- **גמ׳:** introduces חזרה\n    - **Student:** asks about רש״י';
const signal = new AbortController().signal;

void test('notes validation and one repair preserve the full source and copied contracts', async () => {
  const transcriptionSkill = await readFile(
    'packages/transcription/skills/lectern-transcription/SKILL.md',
    'utf8',
  );
  const notesSkill = await readFile(
    'packages/transcription/skills/lectern-notes/SKILL.md',
    'utf8',
  );
  const p = notesProfile(
    {
      model: defaultSettings.model,
      language: 'hebrewEnglish',
      runtime: runtimeIdentity(),
      transcriptionSkill,
      notesSkill,
    },
    'notes-1',
  );
  const requests: string[] = [];
  let saved = '';
  const result = await generateNotes({
    profile: p,
    source: 'The גמ׳ introduces חזרה and the student asks about רש״י.',
    signal,
    saveCleaned: async (text) => {
      saved = text;
    },
    request: async (text) => {
      requests.push(text);
      return requests.length === 1
        ? 'The גמ׳ introduces חזרה and the student asks about רש״י.'
        : requests.length === 2
          ? '# Notes\nA summary'
          : validNotes;
    },
  });
  assert.equal(result.markdown, validNotes);
  assert.equal(requests.length, 3);
  assert.equal(
    normalizeNotes(
      '```markdown\n# Test\n## Topic\n2. First\n    • Second\n```',
    ),
    '# Test\n\n## Topic\n\n1. First\n    - Second',
  );
  assert.ok(requests[0].includes(transcriptionSkill));
  assert.ok(requests[1].includes(notesSkill));
  assert.ok(requests[1].includes(saved));
  assert.match(requests[2], /<draft-notes>/);
  assert.ok(
    notesViolations('# Test\n\n## Test\n\n- A\n  - B', 'source', 'english')
      .length,
  );
  await assert.rejects(
    generateNotes({
      profile: p,
      source: 'lecture',
      cleaned: 'lecture',
      signal,
      saveCleaned: async () => assert.fail('already cleaned'),
      request: async () => '# Notes',
    }),
    { code: 'incomplete_output' },
  );
});

void test('new notes use the complete native transcript in one request and checkpoint it', async () => {
  const source = 'The גמ׳ introduces חזרה and the student asks about רש״י.';
  const p = notesProfile({
    model: defaultSettings.model,
    language: 'hebrewEnglish',
    runtime: runtimeIdentity(),
    transcriptionSkill: 'transcription contract',
    notesSkill: 'notes contract',
  });
  const requests: string[] = [];
  let saved = '';
  const result = await generateNotes({
    profile: p,
    source,
    signal,
    saveCleaned: async (text) => {
      saved = text;
    },
    request: async (prompt) => {
      requests.push(prompt);
      return validNotes;
    },
  });
  assert.equal(
    requests.length,
    1,
    'notes must not pay for a second full transcription pass',
  );
  assert.equal(saved, source);
  assert.equal(result.cleaned, source);
  assert.equal(result.markdown, validNotes);
  assert.ok(requests[0].includes(source));
  assert.ok(requests[0].includes(p.notesSkill));
});

void test(
  'selected ingestion, audio cleanup, generation, and content publication',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yutorah-operator-test-'));
    const schema = 'operator_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
      max: 12,
      application_name: schema,
    });
    const store = new TranscriptionStore(pool, 5);
    const notes = new NotesStore(pool);
    const selections = new SelectionStore(pool);
    const skills = {
      transcriptionSkillPath: resolve(
        'packages/transcription/skills/lectern-transcription/SKILL.md',
      ),
      notesSkillPath: resolve(
        'packages/transcription/skills/lectern-notes/SKILL.md',
      ),
    };
    const skill = await readFile(skills.transcriptionSkillPath, 'utf8');
    const notesSkill = await readFile(skills.notesSkillPath, 'utf8');
    const p = profile(skill, defaultSettings, runtimeIdentity());
    const np = notesProfile({
      model: p.settings.model,
      language: p.settings.language,
      runtime: p.runtime,
      transcriptionSkill: skill,
      notesSkill,
    });
    const legacyNp = notesProfile(
      {
        model: p.settings.model,
        language: p.settings.language,
        runtime: p.runtime,
        transcriptionSkill: skill,
        notesSkill,
      },
      'notes-1',
    );
    const runtime = {
      directory: join(root, 'runtime'),
      profile: join(root, 'profile'),
      scratch: join(root, 'scratch'),
    };
    const config = {
      runtime,
      concurrency: 1,
      pollMs: 10,
      model: p.settings.model,
    };
    const setFixture = async (behavior: string, marker = '') =>
      writeFile(
        join(runtime.directory, 'agy_acp_server.par'),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('apps/worker/test/fixtures/acp.mjs'))} ${quote(behavior)} ${quote(marker)}\n`,
        { mode: 0o700 },
      );
    const docs = (ids = [100, 101, 102]) =>
      ids.map((id) => ({
        shiurid: id,
        teacherid: 80153,
        teacherfullname: 'Rabbi Hershel Schachter',
        seriesid: [4000],
        shiurtitle: `Selected shiur ${id}`,
        shiurdate: '2026-09-23T04:00:00Z',
        mediatypename: 'MP3',
        shiurdownloadurl: `https://download.yutorah.org/${id}.mp3`,
      }));
    const select = async (limit = 2, enabled = true) =>
      selections.saveTarget({
        kind: 'teacher',
        upstreamId: '80153',
        name: 'Rabbi Hershel Schachter',
        limit,
        enabled,
      });
    const publish = async (id = '42') => {
      await store.enqueue(
        { id, title: 'Hilchos Shabbos', teacher: 'Rabbi X' },
        p,
      );
      const job = await store.claim();
      assert.ok(job);
      await store.manifest(job, digest('test-audio'), digest('test-audio'), {
        version: 1,
        durationMs: 10000,
        ranges: [{ start: 0, end: 10, coreStart: 0, coreEnd: 10 }],
      });
      await store.complete(job, {
        schemaVersion: 1,
        durationMs: 10000,
        text: 'The גמ׳ introduces חזרה and the student asks about רש״י.',
        segments: [
          {
            startMs: 1000,
            endMs: 10000,
            text: 'The גמ׳ introduces חזרה and the student asks about רש״י.',
            speaker: 'Rabbi',
            language: null,
          },
        ],
      });
      return job;
    };
    const reset = async () => {
      await pool.query(
        'TRUNCATE transcription_shiurim,transcription_targets,notes_versions CASCADE',
      );
    };
    try {
      for (const file of (await readdir('db/transcription'))
        .filter((f) => /^\d{3}_.+\.sql$/.test(f))
        .sort())
        await pool.query(
          await readFile(join('db/transcription', file), 'utf8'),
        );
      await mkdir(runtime.directory);
      await mkdir(runtime.scratch);
      await prepareProfile(runtime.profile);
      await t.test(
        'quota deadlines persist in PostgreSQL and manual pause clears them',
        async () => {
          const settings = await selections.settings();
          await selections.saveSettings({ ...settings, worker_enabled: true });
          const deadline = new Date('2026-10-01T21:01:00Z');
          assert.equal(
            (await selections.setQuotaResume(deadline))?.getTime(),
            deadline.getTime(),
          );
          assert.equal(
            (
              await new SelectionStore(pool).settings()
            ).quota_resume_at?.getTime(),
            deadline.getTime(),
          );
          await selections.saveSettings({ ...settings, worker_enabled: false });
          assert.equal((await selections.settings()).quota_resume_at, null);
          assert.equal(
            await selections.setQuotaResume(deadline),
            null,
            'a paused operator cannot be silently rearmed',
          );
        },
      );
      await t.test(
        'quota exhaustion stops all lanes and requeues transcription and notes',
        async () => {
          const wav = join(root, 'quota.wav');
          await runProcess(
            '/usr/bin/ffmpeg',
            [
              '-nostdin',
              '-v',
              'error',
              '-f',
              'lavfi',
              '-i',
              'anullsrc=r=16000:cl=mono',
              '-t',
              '10',
              wav,
            ],
            { cwd: root, signal },
          );
          for (const withNotes of [false, true]) {
            await reset();
            if (withNotes) await publish();
            for (let id = 100; id < 120; id++)
              await store.enqueue(
                { id: String(id), title: 'Quota test', teacher: 'Test' },
                p,
              );
            await setFixture('usage_limit');
            await assert.rejects(
              runWorker(
                store,
                {
                  ...config,
                  concurrency: 5,
                  notes: withNotes ? np : undefined,
                  media: {
                    resolveMedia: async () =>
                      'https://download.yutorah.org/test.wav',
                    downloadAudio: async (_url, destination) => {
                      await copyFile(wav, destination);
                    },
                  },
                },
                AbortSignal.timeout(15000),
              ),
              { code: 'quota_exhausted' },
            );
            const rows = (
              await pool.query(
                "SELECT status,attempt FROM transcription_jobs WHERE status<>'completed'",
              )
            ).rows;
            assert.equal(rows.length, 20);
            assert.ok(rows.every((row) => row.status === 'queued'));
            assert.ok(
              rows.filter((row) => row.attempt > 0).length <= 5,
              'exhausted quota must not drain the backlog',
            );
            if (withNotes)
              assert.equal(
                (await pool.query('SELECT status FROM notes_jobs')).rows[0]
                  .status,
                'queued',
              );
            assert.deepEqual(await readdir(runtime.scratch), []);
          }
        },
      );
      await t.test(
        'model changes move only compatible untouched selected jobs',
        async () => {
          await reset();
          const high = profile(
            skill,
            { ...defaultSettings, model: 'gemini-3.8-flash-high' },
            runtimeIdentity(),
          );
          await select(3);
          await scanSelections(store, high, signal, 2, async () => ({
            total: 3,
            docs: docs(),
          }));
          const started = await store.claim(true);
          assert.ok(started);
          await store.finishFailure(started, 'cancelled', true);
          await store.enqueue(
            { id: '999', title: 'Unselected', teacher: 'Other' },
            high,
          );
          assert.equal(await store.reconfigureQueued(p, true), 2);
          const rows = (
            await pool.query('SELECT id,model FROM transcription_jobs')
          ).rows;
          assert.equal(
            rows.find((row) => row.id === started.id).model,
            high.settings.model,
          );
          assert.equal(
            rows.filter((row) => row.model === defaultSettings.model).length,
            2,
          );
          assert.equal(await store.reconfigureQueued(p, true), 0);
        },
      );
      await t.test(
        'model and pipeline changes never silently regenerate existing notes',
        async () => {
          await reset();
          await publish();
          await notes.enqueueMissing(legacyNp);
          await notes.enqueueMissing(np);
          await notes.enqueueMissing(
            notesProfile({
              model: 'gemini-3.8-flash-high',
              language: np.language,
              runtime: np.runtime,
              transcriptionSkill: skill,
              notesSkill,
            }),
          );
          assert.equal(
            (await pool.query('SELECT count(*)::int AS n FROM notes_jobs'))
              .rows[0].n,
            1,
          );
          const job = await notes.claim();
          assert.ok(job);
          await notes.complete(job, validNotes);
          await notes.enqueueMissing(np);
          assert.equal(
            (await pool.query('SELECT count(*)::int AS n FROM notes_jobs'))
              .rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'empty and paused selections never scan the entire archive; budgets resume within a page',
        async () => {
          await reset();
          assert.deepEqual(
            await scanSelections(store, p, signal, 2, async () =>
              assert.fail('no unfiltered scan'),
            ),
            { accepted: 0 },
          );
          await select(2, false);
          assert.deepEqual(
            await scanSelections(store, p, signal, 2, async () =>
              assert.fail('paused'),
            ),
            { accepted: 0 },
          );
          await select(2);
          const fetchPage = async (
            page: number,
            _signal: AbortSignal,
            target?: { kind: string; upstreamId: string },
          ) => {
            assert.equal(page, 1);
            assert.deepEqual(target, { kind: 'teacher', upstreamId: '80153' });
            return { total: 3, docs: docs() };
          };
          const scans = await Promise.all([
            scanSelections(store, p, signal, 2, fetchPage),
            scanSelections(store, p, signal, 2, fetchPage),
          ]);
          assert.equal(
            scans.reduce((s, r) => s + r.accepted, 0),
            2,
          );
          assert.equal((await selections.targets())[0].page_offset, 2);
          await select(3);
          assert.equal(
            (await scanSelections(store, p, signal, 2, fetchPage)).accepted,
            1,
          );
          assert.equal((await selections.targets())[0].imported, 3);
          assert.equal(
            (await scanSelections(store, p, signal, 2, fetchPage)).accepted,
            0,
          );
          await store.enqueue(
            { id: '999', title: 'Unselected', teacher: 'Other' },
            p,
          );
          const chosen = await store.claim(true);
          assert.ok(chosen);
          assert.notEqual(chosen.shiur_id, '999');
          await select(3, false);
          assert.equal(await store.claim(true), null);
          const paused = await selections.snapshot();
          assert.equal(
            paused.jobs.some((j) => j.eligible),
            false,
          );
          assert.equal(
            paused.totals.find((r) => r.status === 'queued')?.count ?? 0,
            0,
          );
        },
      );
      await t.test(
        'overlapping teachers and series share jobs and upstream scope errors never advance',
        async () => {
          await reset();
          await select(2);
          await selections.saveTarget({
            kind: 'series',
            upstreamId: '4000',
            name: 'Daily Shiur',
            limit: 2,
            enabled: true,
          });
          await scanSelections(store, p, signal, 2, async () => ({
            total: 2,
            docs: docs([100, 101]),
          }));
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM transcription_jobs',
              )
            ).rows[0].n,
            2,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM transcription_target_jobs',
              )
            ).rows[0].n,
            4,
          );
          await select(3);
          await assert.rejects(
            scanSelections(store, p, signal, 2, async () => ({
              total: 1,
              docs: [{ ...docs()[0], teacherid: 999 }],
            })),
            { code: 'download' },
          );
          assert.equal((await selections.targets())[0].imported, 2);
          assert.equal((await selections.targets())[0].error, 'download');
        },
      );
      await t.test(
        'a series can be limited to one teacher and narrowing removes old queue ownership',
        async () => {
          await reset();
          await selections.saveTarget({
            kind: 'series',
            upstreamId: '4000',
            name: 'Daily Shiur',
            limit: 2,
            enabled: true,
          });
          await scanSelections(store, p, signal, 2, async () => ({
            total: 2,
            docs: docs([100, 101]),
          }));
          await selections.saveTarget({
            kind: 'series',
            upstreamId: '4000',
            name: 'Daily Shiur',
            limit: 2,
            enabled: true,
            teacherId: '80153',
          });
          assert.equal((await selections.targets())[0].imported, 0);
          assert.equal(await store.claim(true), null);
          await scanSelections(
            store,
            p,
            signal,
            2,
            async (_page, _signal, target) => {
              assert.equal(target?.teacherId, '80153');
              return { total: 2, docs: docs([100, 101]) };
            },
          );
          assert.equal((await selections.targets())[0].imported, 2);
          await selections.saveTarget({
            kind: 'series',
            upstreamId: '4000',
            name: 'Daily Shiur',
            limit: 3,
            enabled: true,
            teacherId: '80153',
          });
          await assert.rejects(
            scanSelections(store, p, signal, 2, async () => ({
              total: 1,
              docs: [{ ...docs()[0], teacherid: 80714 }],
            })),
            { code: 'download' },
          );
        },
      );
      await t.test(
        'changing a series during an in-flight scan preserves its reset cursor and queue scope',
        async () => {
          await reset();
          const series = {
            kind: 'series' as const,
            upstreamId: '4000',
            name: 'Daily Shiur',
            limit: 2,
            enabled: true,
          };
          await selections.saveTarget(series);
          await pool.query(
            'UPDATE transcription_targets SET next_page=7,page_offset=1',
          );
          const result = await scanSelections(
            store,
            p,
            signal,
            2,
            async (page) => {
              assert.equal(page, 7);
              await selections.saveTarget({ ...series, teacherId: '80153' });
              return {
                total: 300,
                docs: docs().map((d) => ({ ...d, mediatypename: 'PDF' })),
              };
            },
          );
          assert.equal(result.accepted, 0);
          const target = (await selections.targets())[0];
          assert.equal(target.teacher_filter, '80153');
          assert.equal(target.next_page, 1);
          assert.equal(target.page_offset, 0);
          assert.equal(target.imported, 0);
          assert.equal(target.error, null);
          await scanSelections(
            store,
            p,
            signal,
            2,
            async (page, _signal, filter) => {
              assert.equal(page, 1);
              assert.equal(filter?.teacherId, '80153');
              return { total: 1, docs: docs([100]) };
            },
          );
          assert.equal((await selections.targets())[0].imported, 1);
          assert.equal((await selections.snapshot()).jobs[0].eligible, true);
        },
      );
      await t.test(
        'real processJob deletes downloaded audio on success, provider failure, and download failure',
        async () => {
          await reset();
          const wav = join(root, 'fixture.wav');
          await runProcess(
            '/usr/bin/ffmpeg',
            [
              '-nostdin',
              '-v',
              'error',
              '-f',
              'lavfi',
              '-i',
              'anullsrc=r=16000:cl=mono',
              '-t',
              '10',
              wav,
            ],
            { cwd: root, signal },
          );
          for (const scenario of [
            'success',
            'provider_failure',
            'download_failure',
          ] as const) {
            const id = String(
              500 +
                ['success', 'provider_failure', 'download_failure'].indexOf(
                  scenario,
                ),
            );
            await store.enqueue({ id, title: scenario, teacher: 'Test' }, p);
            const job = await store.claim();
            assert.ok(job);
            await setFixture(
              scenario === 'provider_failure' ? 'crash' : 'pipeline_audio',
              digest(skill),
            );
            const work = () =>
              processJob(
                store,
                job,
                config,
                new SessionPool(1),
                signal,
                () => {},
                {
                  resolveMedia: async () => 'fixture',
                  downloadAudio: async (_url, destination) => {
                    await copyFile(wav, destination);
                    if (scenario === 'download_failure')
                      throw new Failure('download');
                  },
                },
              );
            if (scenario === 'success') {
              await work();
              assert.ok(await store.content(id));
            } else {
              await assert.rejects(work());
              await store.cancel(job.id);
            }
            assert.deepEqual(
              await readdir(runtime.scratch),
              [],
              `${scenario} must delete the source, chunks and ACP scratch`,
            );
          }
        },
      );
      await t.test(
        'the real worker automatically transcribes selected jobs and generates notes without retaining audio',
        async () => {
          await reset();
          await select(1);
          await scanSelections(store, p, signal, 2, async () => ({
            total: 1,
            docs: docs([100]),
          }));
          await setFixture('pipeline_all', digest(skill));
          const stop = new AbortController();
          const running = runWorker(
            store,
            {
              ...config,
              selectedOnly: true,
              notes: np,
              media: {
                resolveMedia: async () => 'fixture',
                downloadAudio: async (_url, destination) =>
                  copyFile(join(root, 'fixture.wav'), destination),
              },
            },
            stop.signal,
          );
          const outcome = running.catch((error) => {
            if (!stop.signal.aborted) throw error;
          });
          try {
            const deadline = Date.now() + 30000;
            while (
              (await store.content('100'))?.notes?.status !== 'completed' &&
              Date.now() < deadline
            )
              await delay(50);
            assert.equal(
              (await store.content('100'))?.notes?.status,
              'completed',
            );
            assert.deepEqual(await readdir(runtime.scratch), []);
          } finally {
            stop.abort(new Failure('cancelled'));
            await outcome;
          }
        },
      );
      await t.test(
        'sustained notes and transcription backlogs share five ACP processes fairly and drain on pause or leadership loss',
        async () => {
          for (const finish of [
            'complete',
            'pause',
            'leadership_loss',
          ] as const) {
            await reset();
            for (let id = 801; id <= 806; id++) await publish(String(id));
            const ids = [701, 702, 703, 704, 705, 706];
            for (const id of ids)
              await store.enqueue(
                { id: String(id), title: 'Parallel shiur', teacher: 'Test' },
                p,
              );
            const marker = join(root, `parallel-${finish}.jsonl`);
            await setFixture('pipeline_parallel', marker);
            const events = async () =>
              (await readFile(marker, 'utf8').catch(() => ''))
                .trim()
                .split('\n')
                .filter(Boolean)
                .map(
                  (line) =>
                    JSON.parse(line) as {
                      event: string;
                      pid: number;
                      workspace: string;
                      kind?: string;
                    },
                );
            const stop = new AbortController();
            const running = runWorker(
              store,
              {
                ...config,
                concurrency: 5,
                notes: np,
                media: {
                  resolveMedia: async () => 'fixture',
                  downloadAudio: async (_url, destination) =>
                    copyFile(join(root, 'fixture.wav'), destination),
                },
              },
              stop.signal,
            );
            const outcome = running.then(
              () => undefined,
              (error: unknown) => error,
            );
            try {
              const deadline = Date.now() + 10000;
              while (
                (await events()).filter((e) => e.event === 'prompt').length <
                  5 &&
                Date.now() < deadline
              )
                await delay(20);
              const prompts = (await events()).filter(
                (e) => e.event === 'prompt',
              );
              assert.equal(
                prompts.length,
                5,
                'five separate recordings/notes must reach ACP before any request finishes',
              );
              assert.equal(prompts.filter((e) => e.kind === 'audio').length, 3);
              assert.equal(prompts.filter((e) => e.kind === 'notes').length, 2);
              assert.equal(new Set(prompts.map((e) => e.workspace)).size, 5);
              if (finish === 'complete') {
                await writeFile(marker + '.release', 'ready');
                const completeBy = Date.now() + 30000;
                while (Date.now() < completeBy) {
                  const result = await pool.query(
                    "SELECT count(*)::int AS n FROM notes_jobs WHERE status='completed'",
                  );
                  if (result.rows[0].n === 12) break;
                  await delay(50);
                }
                assert.equal(
                  (
                    await pool.query(
                      "SELECT count(*)::int AS n FROM notes_jobs WHERE status='completed'",
                    )
                  ).rows[0].n,
                  12,
                );
                for (const id of ids)
                  assert.equal(
                    (await store.content(String(id)))?.notes?.status,
                    'completed',
                  );
              } else if (finish === 'leadership_loss') {
                const leader = await admin.query(
                  "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.classid=891733 AND l.objid=1 AND l.granted AND a.application_name=$1",
                  [schema],
                );
                assert.equal(leader.rows.length, 1);
                await admin.query('SELECT pg_terminate_backend($1)', [
                  leader.rows[0].pid,
                ]);
                const error = await Promise.race([
                  outcome,
                  delay(5000).then(() =>
                    assert.fail(
                      'leadership loss must promptly drain every session',
                    ),
                  ),
                ]);
                assert.ok(error instanceof Failure);
                assert.equal(error.code, 'lease_lost');
              }
            } finally {
              stop.abort(new Failure('cancelled'));
              await outcome;
            }
            const live = new Set<number>();
            let peak = 0;
            for (const e of await events()) {
              if (e.event === 'opened') live.add(e.pid);
              if (e.event === 'closed') live.delete(e.pid);
              peak = Math.max(peak, live.size);
            }
            assert.equal(
              peak,
              5,
              'notes, audio parts, and separate jobs must all obey the same limit',
            );
            assert.equal(
              live.size,
              0,
              'pause must close every ACP process before releasing leadership',
            );
            assert.deepEqual(await readdir(runtime.scratch), []);
            if (finish !== 'complete') {
              assert.equal(
                (
                  await pool.query(
                    "SELECT count(*)::int AS n FROM transcription_jobs WHERE status='queued'",
                  )
                ).rows[0].n,
                6,
              );
              assert.equal(
                (await pool.query('SELECT status FROM notes_jobs')).rows[0]
                  .status,
                'queued',
              );
            }
          }
        },
      );
      await t.test(
        'notes clean once, repair once, persist independently, and publish through the website bridge',
        async () => {
          await reset();
          await publish();
          await notes.enqueueMissing(legacyNp);
          await notes.enqueueMissing(legacyNp);
          assert.equal(
            (await pool.query('SELECT count(*)::int AS n FROM notes_jobs'))
              .rows[0].n,
            1,
          );
          const job = await notes.claim();
          assert.ok(job);
          assert.equal(await notes.claim(), null);
          const marker = join(root, 'generation.log');
          await setFixture('generation_repair', marker);
          await runLeasedJob(notes, job, signal, (s) =>
            processNotesJob(notes, job, config, s),
          );
          assert.equal(
            await readFile(marker, 'utf8'),
            'cleanup\nnotes\nrepair\n',
          );
          const content = await store.content('42');
          assert.equal(content?.notes?.status, 'completed');
          assert.match(content?.notes?.markdown ?? '', /תוס׳/);
          const token = 'test-content-token-'.repeat(3);
          const server = createSearchServer(store, token);
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          const address = server.address();
          assert.ok(address && typeof address !== 'string');
          const oldUrl = process.env.TRANSCRIPT_API_URL,
            oldToken = process.env.TRANSCRIPT_API_TOKEN;
          process.env.TRANSCRIPT_API_URL = `http://127.0.0.1:${address.port}`;
          process.env.TRANSCRIPT_API_TOKEN = token;
          try {
            assert.equal(
              (
                await fetch(
                  `${process.env.TRANSCRIPT_API_URL}/v1/transcripts/42`,
                )
              ).status,
              401,
            );
            const response = await websiteContent(
              new Request('http://localhost/api/transcript?id=42'),
            );
            assert.equal(response.status, 200);
            assert.equal(
              response.headers.get('cache-control'),
              'public, max-age=60, s-maxage=3600, stale-while-revalidate=300, stale-if-error=86400',
            );
            const body = await response.json();
            assert.equal(body.segments[0].startMs, 1000);
            assert.equal(body.notes.status, 'completed');
            assert.equal(JSON.stringify(body).includes(token), false);
            assert.equal(
              (
                await websiteContent(
                  new Request('http://localhost/api/transcript?id=not-an-id'),
                )
              ).status,
              400,
            );
            assert.equal(
              (
                await websiteContent(
                  new Request('http://localhost/api/transcript?id=999'),
                )
              ).status,
              404,
            );
          } finally {
            if (oldUrl === undefined) delete process.env.TRANSCRIPT_API_URL;
            else process.env.TRANSCRIPT_API_URL = oldUrl;
            if (oldToken === undefined) delete process.env.TRANSCRIPT_API_TOKEN;
            else process.env.TRANSCRIPT_API_TOKEN = oldToken;
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
          assert.deepEqual(await readdir(runtime.scratch), []);
        },
      );
      await t.test(
        'a notes failure preserves its cleaned checkpoint and transcript; retry does not download audio',
        async () => {
          await reset();
          await publish();
          await notes.enqueueMissing(legacyNp);
          const job = await notes.claim();
          assert.ok(job);
          const marker = join(root, 'retry.log');
          await setFixture('generation_invalid', marker);
          await assert.rejects(
            runLeasedJob(notes, job, signal, (s) =>
              processNotesJob(notes, job, config, s),
            ),
            { code: 'incomplete_output' },
          );
          assert.ok((await store.content('42'))?.segments.length);
          assert.equal((await store.content('42'))?.notes?.status, 'failed');
          await pool.query('UPDATE notes_jobs SET attempt=5 WHERE id=$1', [
            job.id,
          ]);
          await notes.retry(job.id);
          const retry = await notes.claim();
          assert.ok(retry);
          assert.ok(retry.cleaned_text);
          await setFixture('generation', marker);
          await processNotesJob(notes, retry, config, signal);
          assert.equal(
            (await readFile(marker, 'utf8'))
              .split('\n')
              .filter((s) => s === 'cleanup').length,
            1,
          );
          assert.equal(
            (
              await pool.query('SELECT attempt FROM notes_jobs WHERE id=$1', [
                job.id,
              ])
            ).rows[0].attempt,
            1,
          );
        },
      );
      await t.test(
        'expired generation leases and cancelled jobs cannot publish; manual retry resets exhausted transcription attempts',
        async () => {
          await reset();
          const transcriptJob = await publish();
          await notes.enqueueMissing(np);
          const old = await notes.claim();
          assert.ok(old);
          await pool.query(
            "UPDATE notes_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
            [old.id],
          );
          const fresh = await notes.claim();
          assert.ok(fresh);
          await assert.rejects(notes.saveCleaned(old, 'stale'), {
            code: 'lease_lost',
          });
          await assert.rejects(notes.complete(old, validNotes), {
            code: 'lease_lost',
          });
          await notes.cancel(fresh.id);
          await assert.rejects(notes.complete(fresh, validNotes), {
            code: 'lease_lost',
          });
          await pool.query(
            "UPDATE transcription_jobs SET status='failed',attempt=5 WHERE id=$1",
            [transcriptJob.id],
          );
          await store.retry(transcriptJob.id);
          const retried = await store.claim();
          assert.equal(retried?.attempt, 1);
        },
      );
      await t.test(
        'text-only ACP generation rejects tool calls before any artifact is published',
        async () => {
          await reset();
          await publish();
          await notes.enqueueMissing(np);
          const job = await notes.claim();
          assert.ok(job);
          await setFixture('generation_tool');
          await assert.rejects(
            runLeasedJob(notes, job, signal, (s) =>
              processNotesJob(notes, job, config, s),
            ),
            { code: 'off_task' },
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM transcript_notes',
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'VM-local operator opens without a password, rejects cross-origin requests, and accepts canonical selections',
        async () => {
          await reset();
          await setFixture('normal');
          const operator = new OperatorRuntime(store, {
            runtime,
            ...skills,
            concurrency: 1,
            intervalMs: 60000,
          });
          const server = createOperatorServer(
            store,
            operator,
            resolve('apps/worker/public'),
            async () => ({
              teachers: [
                { id: '80153', name: 'Rabbi Hershel Schachter', count: 7569 },
              ],
              series: [],
            }),
          );
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          const address = server.address();
          assert.ok(address && typeof address !== 'string');
          const origin = `http://127.0.0.1:${address.port}`;
          try {
            const page = await fetch(origin + '/');
            assert.equal(page.status, 200);
            assert.doesNotMatch(await page.text(), /operator-key|login-form/);
            const polling = await fetch(origin + '/operator-polling.js');
            assert.equal(polling.status, 200);
            assert.match(
              polling.headers.get('Content-Type') ?? '',
              /javascript/,
            );
            assert.equal(
              (await fetch(origin + '/api/operator/status')).status,
              200,
            );
            const headers = {
              'Content-Type': 'application/json',
              'X-Operator-Request': '1',
            };
            const unsafeHeaders: Array<Record<string, string>> = [
              { Origin: 'https://other.example' },
              { 'Sec-Fetch-Site': 'cross-site' },
              { 'X-Forwarded-For': '203.0.113.1' },
            ];
            for (const unsafe of unsafeHeaders)
              assert.equal(
                (
                  await fetch(origin + '/api/operator/status', {
                    headers: unsafe,
                  })
                ).status,
                403,
              );
            const rebound = await new Promise<number>((resolve, reject) => {
              const req = httpRequest(
                origin + '/api/operator/status',
                { headers: { Host: `other.example:${address.port}` } },
                (res) => {
                  res.resume();
                  resolve(res.statusCode!);
                },
              );
              req.on('error', reject);
              req.end();
            });
            assert.equal(rebound, 403);
            assert.equal(
              (
                await fetch(origin + '/api/operator/status', {
                  headers: { Origin: origin },
                })
              ).status,
              200,
            );
            assert.equal(
              (
                await fetch(origin + '/api/operator/session', {
                  method: 'POST',
                  headers,
                  body: '{}',
                })
              ).status,
              404,
            );
            assert.equal(
              (
                await fetch(origin + '/api/operator/stop', {
                  method: 'POST',
                  headers: { ...headers, Origin: 'https://other.example' },
                  body: '{}',
                })
              ).status,
              403,
            );
            assert.equal(
              (
                await fetch(origin + '/api/operator/targets', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: '{}',
                })
              ).status,
              400,
            );
            const add = await fetch(origin + '/api/operator/targets', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                kind: 'teacher',
                upstreamId: '80153',
                name: 'User supplied name',
                limit: 2,
                enabled: true,
              }),
            });
            assert.equal(add.status, 200);
            const status = await (
              await fetch(origin + '/api/operator/status', { headers })
            ).json();
            assert.equal(status.targets[0].name, 'Rabbi Hershel Schachter');
            assert.equal(status.settings.worker_enabled, false);
            assert.equal(
              (
                await fetch(origin + '/api/operator/scan', {
                  method: 'POST',
                  headers,
                  body: '{}',
                })
              ).status,
              400,
            );
            assert.equal((await selections.snapshot()).jobs.length, 0);
            assert.equal(
              (
                await fetch(origin + '/api/operator/targets', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    kind: 'teacher',
                    upstreamId: '000',
                    limit: 2,
                    enabled: true,
                  }),
                })
              ).status,
              400,
            );
          } finally {
            await operator.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
