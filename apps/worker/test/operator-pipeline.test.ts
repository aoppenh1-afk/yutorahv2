import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
  const p = notesProfile({
    model: defaultSettings.model,
    language: 'hebrewEnglish',
    runtime: runtimeIdentity(),
    transcriptionSkill,
    notesSkill,
  });
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

void test(
  'selected ingestion, audio cleanup, generation, and content publication',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yutorah-operator-test-'));
    const schema = 'operator_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
      max: 12,
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
    const publish = async () => {
      await store.enqueue(
        { id: '42', title: 'Hilchos Shabbos', teacher: 'Rabbi X' },
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
        'notes clean once, repair once, persist independently, and publish through the website bridge',
        async () => {
          await reset();
          await publish();
          await notes.enqueueMissing(np);
          await notes.enqueueMissing(np);
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
            assert.equal(response.headers.get('cache-control'), 'no-store');
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
          await notes.enqueueMissing(np);
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
        'operator endpoints require a private session, reject CSRF, and accept canonical directory selections',
        async () => {
          await reset();
          await setFixture('normal');
          const operator = new OperatorRuntime(store, {
            runtime,
            ...skills,
            concurrency: 1,
            intervalMs: 60000,
          });
          const token = 'operator-test-token-'.repeat(3);
          const server = createOperatorServer(
            store,
            operator,
            token,
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
            assert.equal((await fetch(origin + '/')).status, 200);
            assert.equal(
              (await fetch(origin + '/api/operator/status')).status,
              401,
            );
            const login = await fetch(origin + '/api/operator/session', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Operator-Request': '1',
              },
              body: JSON.stringify({ token }),
            });
            assert.equal(login.status, 200);
            const cookie = login.headers.get('set-cookie')!;
            assert.match(cookie, /HttpOnly; SameSite=Strict/);
            const headers = {
              'Content-Type': 'application/json',
              'X-Operator-Request': '1',
              Cookie: cookie.split(';')[0],
            };
            assert.equal(
              (
                await fetch(origin + '/api/operator/targets', {
                  method: 'POST',
                  headers: { Cookie: headers.Cookie },
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
            assert.equal(JSON.stringify(status).includes(token), false);
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
