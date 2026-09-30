import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { TranscriptionStore } from '../.worker-build/packages/transcription/src/store.js';
import { transcribeChunks } from '../.worker-build/packages/transcription/src/engine.js';
import {
  inspectAudio,
  prepareRanges,
  exportChunk,
  audioPreparationIdentity,
} from '../.worker-build/packages/transcription/src/audio.js';
import {
  digest,
  hashFile,
  fingerprint,
} from '../.worker-build/packages/transcription/src/fingerprint.js';
import { transcriptionPrompt } from '../.worker-build/packages/transcription/src/prompt.js';
import { SessionPool } from '../.worker-build/packages/antigravity-acp/src/pool.js';
import {
  prepareProfile,
  withRuntime,
} from '../.worker-build/packages/antigravity-acp/src/runtime.js';

const cli = resolve('.worker-build/apps/worker/src/cli.js');
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function start(executable, args, env = {}) {
  const child = spawn(executable, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output = (output + data).slice(-16000);
  });
  child.stderr.on('data', (data) => {
    output = (output + data).slice(-16000);
  });
  const closed = once(child, 'close');
  // Keep a rejected spawn promise handled until a caller awaits it.
  void closed.catch(() => {});
  return {
    child,
    output: () => output,
    async result() {
      const [code] = await closed;
      assert.equal(code, 0, output);
      return output;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const pid = child.pid;
      if (!pid) {
        await closed;
        return;
      }
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {}
      await Promise.race([closed, delay(5000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }
      await closed;
    },
  };
}

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}

async function ready(process, url, status, headers = {}) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    assert.equal(process.child.exitCode, null, process.output());
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.status === status) return;
    } catch {}
    await delay(100);
  }
  assert.fail(`Service did not become ready: ${url}\n${process.output()}`);
}

void test(
  'compiled pipeline publishes ACP checkpoints through PostgreSQL and the built website',
  { timeout: 120000 },
  async () => {
    assert.ok(
      process.env.TEST_DATABASE_URL,
      'Set TEST_DATABASE_URL to a disposable PostgreSQL database; this smoke check must not be skipped.',
    );
    const root = await mkdtemp(join(tmpdir(), 'yutorah-pipeline-'));
    const schema = 'pipeline_' + randomUUID().replaceAll('-', '');
    const reader = schema + '_reader';
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    const env = { DATABASE_URL: url.href };
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const pool = new Pool({ connectionString: url.href });
    const store = new TranscriptionStore(pool);
    const processes = [];
    const run = async (executable, args, variables) => {
      const process = start(executable, args, variables);
      processes.push(process);
      return process.result();
    };
    let readerCreated = false;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await run(process.execPath, [cli, 'migrate'], env);
      await run(process.execPath, [cli, 'migrate'], env);
      assert.equal(
        (await pool.query('SELECT count(*) FROM transcription_migrations'))
          .rows[0].count,
        '2',
      );
      await run(
        process.execPath,
        [
          cli,
          'enqueue',
          '42',
          '--title',
          'Pipeline validation',
          '--teacher',
          'Test teacher',
          '--audio-url',
          'https://download.yutorah.org/42.mp3',
        ],
        env,
      );
      const job = await store.claim();
      assert.ok(
        job,
        'The compiled enqueue command must create a claimable job.',
      );

      // Google authentication is replaced by ACP only; audio preparation,
      // checkpoints, publication, database permissions and both servers are real.
      const audio = join(root, 'source.wav');
      await run('/usr/bin/ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=16000:cl=mono',
        '-t',
        '10',
        audio,
      ]);
      const signal = new AbortController().signal;
      const info = await inspectAudio(audio, signal);
      const ranges = await prepareRanges(audio, info, signal);
      const audioHash = await hashFile(audio, signal);
      const key = fingerprint({
        jobId: job.id,
        shiurId: job.shiur_id,
        audioHash,
        durationMs: info.durationMs,
        skillHash: job.skill_hash,
        runtime: job.runtime,
        settings: job.settings,
        preparationIdentity: await audioPreparationIdentity(signal, root),
      });
      await store.manifest(job, key, audioHash, {
        version: 1,
        durationMs: info.durationMs,
        ranges,
      });
      const runtime = {
        directory: join(root, 'runtime'),
        profile: join(root, 'profile'),
        scratch: join(root, 'scratch'),
      };
      await mkdir(runtime.directory);
      await prepareProfile(runtime.profile);
      await writeFile(
        join(runtime.directory, 'agy_acp_server.par'),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('apps/worker/test/fixtures/acp.mjs'))} pipeline_audio ${quote(digest(job.skill_text))}\n`,
        { mode: 0o700 },
      );
      const transcript = await transcribeChunks({
        ranges,
        durationMs: info.durationMs,
        settings: job.settings,
        checkpoints: store.checkpoints(job, key),
        pool: new SessionPool(1),
        signal,
        onMerging: () => store.stage(job, 'merging'),
        transcribe: async (input) => {
          const chunk = await exportChunk(
            audio,
            info,
            input.range,
            input.index,
            input.total,
            root,
            input.signal,
          );
          return withRuntime(
            runtime,
            input.signal,
            async (client, workspace) => {
              await client.authenticate();
              await client.session(workspace, job.model);
              return client.prompt(
                transcriptionPrompt(
                  job.skill_text,
                  job.settings,
                  'lecture-audio',
                  input.index,
                  input.total,
                ),
                await readFile(chunk.path),
                chunk.mimeType,
                input.timeoutMs,
              );
            },
          );
        },
      });
      await store.complete(job, transcript);
      assert.equal(
        (
          await pool.query(
            'SELECT status FROM transcription_jobs WHERE id=$1',
            [job.id],
          )
        ).rows[0].status,
        'completed',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*) FROM transcription_chunks WHERE job_id=$1',
            [job.id],
          )
        ).rows[0].count,
        '1',
      );

      await admin.query(
        `CREATE ROLE ${reader} LOGIN PASSWORD '${randomBytes(24).toString('hex')}'`,
      );
      readerCreated = true;
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${reader}`);
      await admin.query(
        `GRANT SELECT ON ${schema}.transcription_shiurim, ${schema}.transcript_segments TO ${reader}`,
      );
      const readerClient = await pool.connect();
      try {
        await readerClient.query(`SET ROLE ${reader}`);
        await assert.rejects(
          readerClient.query('DELETE FROM transcript_segments'),
          { code: '42501' },
        );
        await assert.rejects(
          readerClient.query('SELECT * FROM transcription_jobs'),
          { code: '42501' },
        );
      } finally {
        await readerClient.query('RESET ROLE');
        readerClient.release();
      }
      // SET ROLE works with both the local peer-auth database and CI's TCP login.
      const readUrl = new URL(url);
      readUrl.searchParams.set(
        'options',
        `-c search_path=${schema},public -c role=${reader}`,
      );
      const searchPort = await port();
      const token = randomBytes(32).toString('hex');
      const search = start(process.execPath, [cli, 'serve-search'], {
        DATABASE_URL: readUrl.href,
        TRANSCRIPT_API_TOKEN: token,
        TRANSCRIPT_API_PORT: String(searchPort),
      });
      processes.push(search);
      const searchOrigin = `http://127.0.0.1:${searchPort}`;
      await ready(search, `${searchOrigin}/health`, 401);
      await ready(search, `${searchOrigin}/health`, 200, {
        Authorization: `Bearer ${token}`,
      });

      const build = JSON.parse(
        await readFile('dist/server/wrangler.json', 'utf8'),
      );
      const config = join(root, 'wrangler.json');
      build.main = resolve('dist/server', build.main);
      build.assets.directory = resolve('dist/server', build.assets.directory);
      build.d1_databases.forEach((database) => {
        database.migrations_dir = resolve('drizzle');
      });
      build.vars = {
        ...build.vars,
        TRANSCRIPT_API_URL: searchOrigin,
        TRANSCRIPT_API_TOKEN: token,
      };
      await writeFile(config, JSON.stringify(build), { mode: 0o600 });
      const state = join(root, 'd1');
      await run(process.execPath, [
        wrangler,
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--config',
        config,
        '--persist-to',
        state,
      ]);
      const websitePort = await port();
      const website = start(process.execPath, [
        wrangler,
        'dev',
        '--config',
        config,
        '--persist-to',
        state,
        '--ip',
        '127.0.0.1',
        '--port',
        String(websitePort),
        '--inspector-port',
        '0',
      ]);
      processes.push(website);
      const websiteOrigin = `http://127.0.0.1:${websitePort}`;
      await ready(website, `${websiteOrigin}/api/transcript-search?q=`, 400);
      for (const [query, startMs] of [
        ['תוס', 1000],
        ['what about', 4000],
      ]) {
        const response = await fetch(
          `${websiteOrigin}/api/transcript-search?q=${encodeURIComponent(query)}`,
        );
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json();
        assert.equal(body.results.length, 1);
        assert.equal(body.results[0].shiurId, '42');
        assert.equal(body.results[0].startMs, startMs);
        assert.equal(body.results[0].href, `/?shiur=42&t=${startMs / 1000}`);
        assert.equal(JSON.stringify(body).includes(token), false);
      }
      const invalid = await fetch(
        `${websiteOrigin}/api/transcript-search?q=...`,
      );
      assert.equal(invalid.status, 400);
      await search.stop();
      const unavailable = await fetch(
        `${websiteOrigin}/api/transcript-search?q=test`,
      );
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    } finally {
      for (const process of processes.toReversed()) await process.stop();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (readerCreated) await admin.query(`DROP ROLE ${reader}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
