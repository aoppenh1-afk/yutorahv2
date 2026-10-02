import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  TranscriptionStore,
  profile,
  type Job,
} from '../../../packages/transcription/src/store.js';
import { transcribeChunks } from '../../../packages/transcription/src/engine.js';
import { SessionPool } from '../../../packages/antigravity-acp/src/pool.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import {
  defaultSettings,
  type Range,
  type Segment,
  type Transcript,
} from '../../../packages/transcription/src/types.js';
import { runLeasedJob } from '../src/worker.js';
import { backfillPages, scanHomepage, scanRecent } from '../src/catalog.js';

void test(
  'PostgreSQL queue, checkpoints, search and real worker restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = 'worker_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
      max: 8,
    });
    const store = new TranscriptionStore(pool);
    const sql = await readFile('db/transcription/001_initial.sql', 'utf8');
    await pool.query(sql);
    await pool.query(await readFile('db/transcription/002_catalog_cursor.sql', 'utf8'));
    await pool.query(await readFile('db/transcription/003_tolerant_search.sql', 'utf8'));
    await pool.query(await readFile('db/transcription/004_operator_notes.sql', 'utf8'));
    const skill = await readFile(
      'packages/transcription/skills/lectern-transcription/SKILL.md',
      'utf8',
    );
    const version = profile(skill, defaultSettings, 'fixture-runtime');
    let serial = 1000;
    const enqueue = () =>
      store.enqueue(
        { id: String(serial++), title: 'Hilchos Shabbos', teacher: 'Rabbi X' },
        version,
      );
    const range: Range = { start: 0, end: 10, coreStart: 0, coreEnd: 10 };
    const segment = (text = 'the גמ׳ introduces חזרה'): Segment => ({
      startMs: 1000,
      endMs: 10000,
      text,
      speaker: 'Rabbi',
      language: null,
    });
    const manifest = {
      version: 1 as const,
      durationMs: 10000,
      ranges: [range],
    };
    const claimed = async (): Promise<Job> => {
      const j = await store.claim();
      assert.ok(j);
      return j;
    };
    try {
      await t.test(
        'enqueue is idempotent and concurrent claims are exclusive',
        async () => {
          const shiur = { id: String(serial++), title: 'A', teacher: 'B' };
          const ids = await Promise.all(
            Array.from({ length: 4 }, () => store.enqueue(shiur, version)),
          );
          assert.equal(new Set(ids).size, 1);
          const jobs = await Promise.all(
            Array.from({ length: 4 }, () => store.claim()),
          );
          assert.equal(jobs.filter(Boolean).length, 1);
          await store.cancel(ids[0]);
          assert.equal(await store.claim(), null);
        },
      );
      await t.test(
        'durable chunks survive a new store, corrupt parts and manifests are rejected',
        async () => {
          await enqueue();
          const job = await claimed();
          await store.manifest(job, 'key', 'audio', manifest);
          await store.checkpoints(job, 'key').save(0, range, [segment()]);
          const next = new TranscriptionStore(pool);
          assert.deepEqual(await next.checkpoints(job, 'key').load(0, range), [
            segment(),
          ]);
          assert.equal(
            await next.checkpoints(job, 'different-skill-key').load(0, range),
            null,
          );
          await pool.query(
            "UPDATE transcription_chunks SET payload=jsonb_set(payload,'{segments,0,text}','\"corrupt\"') WHERE job_id=$1",
            [job.id],
          );
          assert.equal(await next.checkpoints(job, 'key').load(0, range), null);
          await store.checkpoints(job, 'key').save(0, range, [segment()]);
          const changedRange = { ...range, end: 9 };
          assert.equal(
            await next.checkpoints(job, 'key').load(0, changedRange),
            null,
          );
          assert.equal(
            next.savedManifest(
              { ...job, manifest_digest: 'bad' },
              'key',
              10000,
            ),
            null,
          );
          await next.manifest(
            { ...job, manifest_digest: 'bad' },
            'key',
            'audio',
            manifest,
          );
          assert.equal(await next.checkpoints(job, 'key').load(0, range), null);
          await store.cancel(job.id);
        },
      );
      await t.test(
        'expired lease reclaim fences every write from the old worker',
        async () => {
          await enqueue();
          const old = await claimed();
          await store.manifest(old, 'key', 'audio', manifest);
          await store.checkpoints(old, 'key').save(0, range, [segment()]);
          await pool.query(
            "UPDATE transcription_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
            [old.id],
          );
          const next = await claimed();
          assert.equal(next.id, old.id);
          assert.notEqual(next.lease_token, old.lease_token);
          await assert.rejects(
            store.checkpoints(old, 'key').save(0, range, [segment('stale')]),
            Failure,
          );
          await assert.rejects(store.stage(old, 'merging'), Failure);
          assert.equal(
            (await store.checkpoints(next, 'key').load(0, range))?.[0].text,
            segment().text,
          );
          await store.cancel(next.id);
        },
      );
      await t.test('exhausted crashed job fails without blocking queued jobs', async () => {
        const exhaustedId = await enqueue();
        const exhausted = await claimed();
        assert.equal(exhausted.id, exhaustedId);
        const nextId = await enqueue();
        await pool.query(
          "UPDATE transcription_jobs SET attempt=5,lease_until=now()-interval '1 second' WHERE id=$1",
          [exhaustedId],
        );
        const next = await claimed();
        assert.equal(next.id, nextId);
        const state = await pool.query(
          'SELECT status,error,completed_at FROM transcription_jobs WHERE id=$1',
          [exhaustedId],
        );
        assert.equal(state.rows[0].status, 'failed');
        assert.deepEqual(state.rows[0].error, { code: 'attempts_exhausted' });
        assert.ok(state.rows[0].completed_at);
        await store.cancel(nextId);
      });
      await t.test('idle database pool failure exits the search service nonzero', async () => {
        const portPicker = createServer();
        portPicker.listen(0, '127.0.0.1');
        await once(portPicker, 'listening');
        const address = portPicker.address();
        assert.ok(address && typeof address !== 'string');
        await new Promise<void>((resolve) => portPicker.close(() => resolve()));
        const token = 'c'.repeat(48);
        const appName = `pool_failure_${randomUUID().replaceAll('-', '')}`;
        const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
        databaseUrl.searchParams.set('options', `-c search_path=${schema},public`);
        databaseUrl.searchParams.set('application_name', appName);
        const child = fork('apps/worker/src/cli.ts', ['serve-search'], {
          execArgv: ['--import', 'tsx'],
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl.href,
            TRANSCRIPT_API_PORT: String(address.port),
            TRANSCRIPT_API_TOKEN: token,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let output = '';
        child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
        const exited = once(child, 'close');
        const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
        try {
          const url = `http://127.0.0.1:${address.port}`;
          let ready = false;
          for (let i = 0; i < 60; i++) {
            try {
              const response = await fetch(`${url}/health`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (response.ok) { ready = true; break; }
            } catch { /* Service is still starting. */ }
            await delay(50);
          }
          assert.ok(ready, 'search service must start');
          const response = await fetch(`${url}/v1/transcripts/search?q=חזרה`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          assert.equal(response.status, 200);
          await response.arrayBuffer();
          const backends = await admin.query<{ pid: number }>(
            'SELECT pid FROM pg_stat_activity WHERE application_name=$1',
            [appName],
          );
          assert.equal(backends.rowCount, 1);
          await admin.query('SELECT pg_terminate_backend($1)', [backends.rows[0].pid]);
          const [exitCode] = await exited;
          assert.equal(exitCode, 1);
          assert.match(output, /"event":"worker_stopped","code":"lease_lost"/);
        } finally {
          clearTimeout(watchdog);
          child.kill('SIGKILL');
          await exited;
        }
      });
      await t.test(
        'final publication is atomic, searchable in Hebrew/English, and links to time',
        async () => {
          await enqueue();
          const job = await claimed();
          await store.manifest(job, 'search-key', 'audio', manifest);
          const transcript: Transcript = {
            schemaVersion: 1,
            durationMs: 10000,
            text: 'boom',
            segments: [segment('boom')],
          };
          await pool.query(
            "ALTER TABLE transcript_segments ADD CONSTRAINT fixture_failure CHECK (text <> 'boom')",
          );
          await assert.rejects(store.complete(job, transcript));
          assert.equal(
            (
              await pool.query('SELECT * FROM transcripts WHERE job_id=$1', [
                job.id,
              ])
            ).rowCount,
            0,
          );
          assert.notEqual(
            (
              await pool.query(
                'SELECT status FROM transcription_jobs WHERE id=$1',
                [job.id],
              )
            ).rows[0].status,
            'completed',
          );
          await pool.query(
            'ALTER TABLE transcript_segments DROP CONSTRAINT fixture_failure',
          );
          const segments = [
            {
              ...segment(
                'Opening context. '.repeat(30) +
                  'The גמ׳ introduces חזרה with תוס׳, רש״י and מיגו. There are 613 mitzvos. Daf Yomi and building bitachon. Hachnasas Orchim, Sefiras HaOmer, Birkas Hamazon, and כיבוד הורים. ' +
                  'Closing context. '.repeat(30) +
                  'Lashon',
              ),
              endMs: 4000,
            },
            {
              ...segment('hara. An exact phrase crosses'),
              startMs: 4000,
              endMs: 6000,
            },
            {
              ...segment(
                'a segment boundary. Whatever happens. What about this?',
              ),
              startMs: 6000,
            },
          ];
          await store.complete(job, {
            ...transcript,
            segments,
            text: segments.map((s) => s.text).join('\n\n'),
          });
          for (const query of [
            'חזרה',
            'chazara',
            'Tosfos',
            'תוס׳',
            'Rashi',
            'רש״י',
            'migo',
            'מיגו',
          ]) {
            const results = await store.search(query);
            assert.equal(results.length, 1, query);
            assert.equal(results[0].startMs, 1000);
            assert.equal(results[0].href, `/?shiur=${job.shiur_id}&t=1`);
          }
          assert.equal((await store.search('Rashi', false)).length, 0);
          assert.equal(
            (await store.search('חזרה', true, 20, 'terms')).length,
            1,
          );
          const phrase = await store.search('phrase crosses a segment');
          assert.equal(phrase.length, 1);
          assert.equal(phrase[0].startMs, 4000);
          for (const query of [
            'chazra',
            'Tosf',
            'introducs',
            'intro',
            'רשי',
            'mitzvot',
            '613',
          ]) {
            const smart = await store.search(query, true, 20, 'smart');
            assert.equal(smart.length, 1, query);
            assert.equal(smart[0].startMs, 1000, query);
          }
          const partialTypo = await store.search(
            'segmnt boudn',
            true,
            20,
            'smart',
          );
          assert.ok(
            (
              await store.search('introducs', true, 20, 'smart')
            )[0].text.includes('introduces'),
          );
          assert.equal(partialTypo.length, 1);
          assert.equal(partialTypo[0].startMs, 6000);
          for (const query of ['what about', 'what']) {
            const spoken = await store.search(query, true, 20, 'smart');
            assert.equal(spoken.length, 1, query);
            assert.equal(spoken[0].startMs, 6000, query);
          }
          const crossing = await store.search(
            'phrsae crosses seg',
            true,
            20,
            'smart',
          );
          assert.equal(crossing.length, 1);
          assert.equal(crossing[0].startMs, 4000);
          assert.equal(
            (await store.search('introducs', true, 20, 'phrase')).length,
            0,
          );
          assert.equal(
            (await store.search('introducs', true, 20, 'terms')).length,
            0,
          );
          assert.equal(
            (await store.search('614', true, 20, 'smart')).length,
            0,
          );
          assert.equal(
            (await store.search('chazra astronomy', true, 20, 'smart')).length,
            0,
          );
          for (const query of [
            'daf ymi',
            'daf ymo',
            'dafyomi',
            'anxiety',
            'gossip',
            'How can I welcome guests?',
            'counting the omer',
            'blessings after eating',
            'honouring our parents',
            'ובכיבוד הורים',
          ]) {
            const intent = await store.search(query, true, 20, 'smart');
            assert.equal(intent.length, 1, query);
            assert.equal(intent[0].startMs, 1000, query);
          }
          assert.equal(
            (await store.search('anxiety', true, 20, 'phrase')).length,
            0,
          );
          assert.equal(
            (await store.search('dafyomi', true, 20, 'phrase')).length,
            0,
          );
          assert.equal(
            (await store.search('dafyomi', false, 20, 'smart')).length,
            0,
          );
          assert.equal(
            (
              await store.search(
                'How can I welcome guests?',
                true,
                20,
                'phrase',
              )
            ).length,
            0,
          );
          assert.equal(
            (await store.search('counting the omer', true, 20, 'terms')).length,
            0,
          );
          assert.ok(
            (
              await pool.query(
                'SELECT word FROM transcript_search_words WHERE word=$1',
                ['introduces'],
              )
            ).rowCount,
          );
        },
      );
      await t.test(
        'skill update creates a distinct version and job without reusing accepted parts',
        async () => {
          const shiur = { id: String(serial++), title: 'A', teacher: 'B' };
          const old = await store.enqueue(shiur, version);
          const changed = profile(
            skill + '\nNew orthography guidance.\n',
            defaultSettings,
            'fixture-runtime',
          );
          const next = await store.enqueue(shiur, changed);
          assert.notEqual(old, next);
          assert.notEqual(version.skillHash, changed.skillHash);
          await store.cancel(old);
          await store.cancel(next);
        },
      );
      await t.test(
        'catalog discovery resumes a persisted cursor and backfill stays low priority',
        async () => {
          const today = new Date().toISOString();
          const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
          const docs = (start: number, size: number, date: string) =>
            Array.from({ length: size }, (_, i) => ({
              shiurID: start + i,
              shiurTitle: `Shiur ${start + i}`,
              shiurTeachers: [{ teacherName: 'Rabbi X' }],
              shiurDate: date,
              shiurMediaType: 'MP3',
              downloadURL: `https://shiurim.yutorah.net/${start + i}.MP3`,
            }));
          const pages = [docs(3000000, 30, today), docs(3000030, 30, today), docs(3000060, 1, old)];
          const fetched: number[] = [];
          const fetchPage = async (page: number) => {
            fetched.push(page);
            return { total: 61, docs: pages[page - 1] ?? [] };
          };
          const recent = await scanRecent(
            store,
            version,
            new AbortController().signal,
            { pagesPerPoll: 2, fetchPage },
          );
          assert.deepEqual(recent, { pages: 2, audio: 60 });
          assert.equal(await store.catalogCursor('recent'), 3);
          await scanHomepage(
            store,
            version,
            new AbortController().signal,
            async () => [{
              ...pages[0][0],
              downloadURL: 'https://download.yutorah.org/3000000.mp3',
            }],
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM transcription_jobs WHERE shiur_id='3000000'")).rows[0].n,
            1,
          );
          const resumed = new TranscriptionStore(pool);
          await scanRecent(resumed, version, new AbortController().signal, {
            pagesPerPoll: 2,
            fetchPage,
          });
          assert.deepEqual(fetched, [1, 2, 1, 3]);
          assert.equal(await resumed.catalogCursor('recent'), 2);
          await pool.query(
            "UPDATE transcription_catalog_cursors SET last_complete_at=now()-interval '10 days' WHERE name='recent'",
          );
          await scanRecent(resumed, version, new AbortController().signal, {
            pagesPerPoll: 2,
            fetchPage,
          });
          await scanRecent(resumed, version, new AbortController().signal, {
            pagesPerPoll: 2,
            fetchPage,
          });
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM transcription_jobs WHERE shiur_id='3000060'")).rows[0].n,
            1,
          );
          const backfill = await backfillPages(
            resumed,
            version,
            1,
            new AbortController().signal,
            fetchPage,
          );
          assert.deepEqual(backfill, { pages: 1, audio: 30, nextPage: 2 });
          assert.equal(await resumed.catalogCursor('backfill'), 2);
          const priorities = await pool.query(
            "SELECT DISTINCT priority FROM transcription_jobs WHERE shiur_id LIKE '3000%'",
          );
          assert.deepEqual(priorities.rows.map((r) => r.priority), [0]);
          await pool.query("DELETE FROM transcription_shiurim WHERE id LIKE '3000%'");
        },
      );
      await t.test(
        'graceful shutdown requeues; explicit cancellation stays cancelled',
        async () => {
          await enqueue();
          const job = await claimed();
          const shutdown = new AbortController();
          await assert.rejects(
            runLeasedJob(
              store,
              job,
              shutdown.signal,
              async (signal) => {
                shutdown.abort(new Failure('cancelled'));
                signal.throwIfAborted();
              },
              10,
            ),
            Failure,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT status FROM transcription_jobs WHERE id=$1',
                [job.id],
              )
            ).rows[0].status,
            'queued',
          );
          await store.cancel(job.id);
          await enqueue();
          const cancel = await claimed();
          await assert.rejects(
            runLeasedJob(
              store,
              cancel,
              new AbortController().signal,
              async (signal) => {
                await store.cancel(cancel.id);
                await delay(1000, undefined, { signal });
              },
              10,
            ),
            Failure,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT status FROM transcription_jobs WHERE id=$1',
                [cancel.id],
              )
            ).rows[0].status,
            'cancelled',
          );
        },
      );
      await t.test(
        'SIGKILL after seven of ten chunks resumes only the remaining three',
        async () => {
          const id = await enqueue();
          const child = fork('apps/worker/test/fixtures/crash-worker.ts', [], {
            execArgv: ['--import', 'tsx'],
            env: { ...process.env, TEST_SCHEMA: schema },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          });
          const exited = once(child, 'exit');
          try {
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('Crash fixture timed out')),
                15000,
              );
              child.on('message', (message) => {
                if ((message as { saved?: number }).saved === 7) {
                  clearTimeout(timeout);
                  resolve();
                }
              });
              child.once('exit', () => {
                clearTimeout(timeout);
                reject(new Error('Fixture exited early'));
              });
            });
            child.kill('SIGKILL');
            await exited;
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int AS n FROM transcription_chunks WHERE job_id=$1',
                  [id],
                )
              ).rows[0].n,
              7,
            );
            await pool.query(
              "UPDATE transcription_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
              [id],
            );
            const resumedStore = new TranscriptionStore(pool);
            const job = await resumedStore.claim();
            assert.ok(job);
            assert.equal(job.id, id);
            const saved = resumedStore.savedManifest(
              job,
              'crash-fixture',
              100000,
            );
            assert.ok(saved);
            const calls: number[] = [];
            await runLeasedJob(
              resumedStore,
              job,
              new AbortController().signal,
              async (signal) => {
                const result = await transcribeChunks({
                  ranges: saved.ranges,
                  durationMs: 100000,
                  settings: job.settings,
                  checkpoints: resumedStore.checkpoints(job, 'crash-fixture'),
                  pool: new SessionPool(3),
                  signal,
                  transcribe: async ({ index }) => {
                    calls.push(index);
                    return `[00:01] Part${index}`;
                  },
                });
                await resumedStore.complete(job, result);
              },
            );
            assert.deepEqual(
              calls.sort((a, b) => a - b),
              [7, 8, 9],
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT status FROM transcription_jobs WHERE id=$1',
                  [id],
                )
              ).rows[0].status,
              'completed',
            );
            const rows = await pool.query(
              'SELECT text,start_ms FROM transcript_segments WHERE shiur_id=$1 ORDER BY segment_index',
              [job.shiur_id],
            );
            assert.deepEqual(
              rows.rows.map((r) => r.text),
              Array.from({ length: 10 }, (_, i) => `Part${i}`),
            );
          } finally {
            child.kill('SIGKILL');
            await exited;
          }
        },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
