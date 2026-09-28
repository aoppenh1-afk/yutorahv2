import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type PoolClient } from 'pg';
import {
  withRuntime,
  release,
  type RuntimeConfig,
} from '../../../packages/antigravity-acp/src/runtime.js';
import { SessionPool } from '../../../packages/antigravity-acp/src/pool.js';
import {
  Failure,
  failure,
  checkAbort,
} from '../../../packages/antigravity-acp/src/errors.js';
import {
  TranscriptionStore,
  type Job,
  type Profile,
} from '../../../packages/transcription/src/store.js';
import {
  audioPreparationIdentity,
  exportChunk,
  inspectAudio,
  prepareRanges,
} from '../../../packages/transcription/src/audio.js';
import {
  digest,
  fingerprint,
  hashFile,
} from '../../../packages/transcription/src/fingerprint.js';
import {
  transcribeChunks,
  type TranscribeChunk,
} from '../../../packages/transcription/src/engine.js';
import { transcriptionPrompt } from '../../../packages/transcription/src/prompt.js';
import {
  downloadAudio,
  resolveMedia,
} from '../../../packages/yutorah-core/src/media.js';
import { pollCatalog } from './catalog.js';

export type WorkerConfig = {
  runtime: RuntimeConfig;
  concurrency: number;
  pollMs: number;
  model?: string;
  catalog?: { profile: Profile; intervalMs: number; deepIntervalMs: number };
};
export type Diagnostic = {
  event: string;
  job?: string;
  chunk?: number;
  attempt?: number;
  elapsedMs?: number;
  code?: string;
  pages?: number;
  audio?: number;
  nextPage?: number;
};
export const log = (event: Diagnostic) =>
  process.stdout.write(JSON.stringify(event) + '\n');
export const runtimeIdentity = () =>
  `${release.version}:${release[process.arch === 'arm64' ? 'arm64' : 'x64'].sha256}`;

export async function processJob(
  store: TranscriptionStore,
  job: Job,
  config: WorkerConfig,
  pool: SessionPool,
  signal: AbortSignal,
  diagnostic = log,
): Promise<void> {
  if (
    digest(job.skill_text) !== job.skill_hash ||
    job.runtime !== runtimeIdentity()
  )
    throw new Failure('configuration');
  checkAbort(signal);
  const root = await mkdtemp(join(config.runtime.scratch, 'job-'));
  const source = join(root, 'source.audio');
  try {
    await store.stage(job, 'downloading');
    const url = await resolveMedia(job.shiur_id, job.source_url, signal);
    await downloadAudio(url, source, signal);
    await store.stage(job, 'preparing');
    const info = await inspectAudio(source, signal);
    const audioHash = await hashFile(source, signal);
    const preparationIdentity = await audioPreparationIdentity(signal, root);
    const key = fingerprint({
      jobId: job.id,
      shiurId: job.shiur_id,
      audioHash,
      durationMs: info.durationMs,
      skillHash: job.skill_hash,
      runtime: job.runtime,
      settings: job.settings,
      preparationIdentity,
    });
    const ranges =
      store.savedManifest(job, key, info.durationMs)?.ranges ??
      (await prepareRanges(source, info, signal));
    await store.manifest(job, key, audioHash, {
      version: 1,
      durationMs: info.durationMs,
      ranges,
    });
    await store.stage(job, 'transcribing');
    const transcribe: TranscribeChunk = async (input) => {
      const audio = await exportChunk(
        source,
        info,
        input.range,
        input.index,
        input.total,
        root,
        input.signal,
      );
      try {
        return await withRuntime(
          config.runtime,
          input.signal,
          async (client, workspace) => {
            await client.authenticate();
            await client.session(workspace, job.model);
            const name =
              input.total === 1
                ? 'lecture-audio'
                : `lecture-audio-part-${input.index + 1}-of-${input.total}`;
            return client.prompt(
              transcriptionPrompt(
                job.skill_text,
                job.settings,
                name,
                input.index,
                input.total,
              ),
              await readFile(audio.path),
              audio.mimeType,
              input.timeoutMs,
            );
          },
        );
      } finally {
        if (audio.path !== source) await rm(audio.path, { force: true });
      }
    };
    const transcript = await transcribeChunks({
      ranges,
      durationMs: info.durationMs,
      settings: job.settings,
      checkpoints: store.checkpoints(job, key),
      pool,
      signal,
      transcribe,
      onMerging: () => store.stage(job, 'merging'),
      diagnostic: (event) =>
        diagnostic({ event: 'chunk_failure', job: job.id, ...event }),
    });
    await store.complete(job, transcript);
    diagnostic({ event: 'completed', job: job.id });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Heartbeat failure cancels owned work; losing a lease can never publish a transcript. */
export async function runLeasedJob(
  store: TranscriptionStore,
  job: Job,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<void>,
  heartbeatMs = 20_000,
): Promise<void> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const stopHeartbeat = new AbortController();
  const heartbeat = (async () => {
    while (!stopHeartbeat.signal.aborted) {
      try {
        await delay(heartbeatMs, undefined, { signal: stopHeartbeat.signal });
      } catch {
        break;
      }
      try {
        await store.heartbeat(job);
      } catch {
        controller.abort(new Failure('lease_lost'));
        break;
      }
    }
  })();
  try {
    await work(combined);
  } catch (error) {
    const code =
      combined.aborted && combined.reason instanceof Failure
        ? combined.reason.code
        : failure(error).code;
    await store.finishFailure(job, code, signal.aborted).catch(() => {});
    throw new Failure(code);
  } finally {
    stopHeartbeat.abort();
    await heartbeat;
  }
}

export async function runWorker(
  store: TranscriptionStore,
  config: WorkerConfig,
  signal: AbortSignal,
): Promise<void> {
  const leader: PoolClient = await store.pool.connect();
  const lost = new AbortController();
  const catalogStop = new AbortController();
  let catalogTask: Promise<void> | undefined;
  const combined = AbortSignal.any([signal, lost.signal]);
  const lostLeadership = () => lost.abort(new Failure('lease_lost'));
  leader.on('error', lostLeadership);
  try {
    const lock = await leader.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(891733,1) AS acquired',
    );
    if (!lock.rows[0].acquired) throw new Failure('configuration');
    await mkdir(config.runtime.scratch, { recursive: true, mode: 0o700 });
    // This directory belongs only to the single worker service. systemd first kills
    // the previous cgroup. Authentication uses a different scratch directory.
    for (const entry of await readdir(config.runtime.scratch, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && /^(job|acp)-[A-Za-z0-9]+$/.test(entry.name))
        await rm(join(config.runtime.scratch, entry.name), { recursive: true });
    }
    const pool = new SessionPool(config.concurrency);
    await withRuntime(config.runtime, combined, async (client, workspace) => {
      await client.authenticate();
      await client.session(workspace, config.model);
    });
    if (config.catalog) {
      catalogTask = pollCatalog(
        store,
        config.catalog.profile,
        AbortSignal.any([combined, catalogStop.signal]),
        config.catalog.intervalMs,
        log,
        config.catalog.deepIntervalMs,
      );
    }
    while (!combined.aborted) {
      // A broken leadership connection cannot admit more jobs.
      await leader.query('SELECT 1');
      const job = await store.claim();
      if (!job) {
        await delay(config.pollMs, undefined, { signal: combined });
        continue;
      }
      log({ event: 'claimed', job: job.id, attempt: job.attempt });
      try {
        await runLeasedJob(store, job, combined, (s) =>
          processJob(store, job, config, pool, s),
        );
      } catch (error) {
        const e = failure(error);
        log({ event: 'job_failed', job: job.id, code: e.code });
        if (
          ['auth_required', 'configuration', 'lease_lost'].includes(e.code) &&
          !signal.aborted
        )
          throw e;
      }
    }
    // Loss during successful preflight/cleanup must still reach the CLI as a failure.
    checkAbort(combined);
  } finally {
    catalogStop.abort();
    try {
      await catalogTask;
    } finally {
      leader.removeListener('error', lostLeadership);
      await leader.query('SELECT pg_advisory_unlock(891733,1)').catch(() => {});
      leader.release();
    }
  }
}
