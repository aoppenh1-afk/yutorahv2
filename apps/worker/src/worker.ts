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
import { performanceSample } from '../../../lib/performance-metrics.js';
import type { ACPClient } from '../../../packages/antigravity-acp/src/client.js';
import {
  recoverConversations,
  pruneConversations,
} from '../../../packages/antigravity-acp/src/session-cleanup.js';
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
import { pollSelections } from './selections.js';
import { workWake } from '../../../packages/transcription/src/work-wake.js';
import {
  NotesStore,
  type NotesJob,
} from '../../../packages/transcription/src/notes-store.js';
import {
  generateNotes,
  notesProfile,
  type NotesProfile,
} from '../../../packages/transcription/src/notes.js';

export type WorkerConfig = {
  runtime: RuntimeConfig;
  concurrency: number;
  pollMs: number;
  model?: string;
  catalog?: { profile: Profile; intervalMs: number; deepIntervalMs: number };
  selectedOnly?: boolean;
  notes?: NotesProfile;
  onReady?: (models: string[], pool: SessionPool) => void;
  onQuotaExhausted?: () => void;
  media?: {
    resolveMedia: typeof resolveMedia;
    downloadAudio: typeof downloadAudio;
  };
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
  accepted?: number;
  model?: string;
  kind?: 'transcription' | 'cleanup' | 'notes' | 'notes_repair';
  audioSeconds?: number;
  audioBytes?: number;
  inputTextBytes?: number;
  outputTextBytes?: number;
  thoughtChunks?: number;
  thoughtBytes?: number;
};
export const log = (event: Diagnostic) =>
  process.stdout.write(JSON.stringify(event) + '\n');
export const runtimeIdentity = () =>
  `${release.version}:${release[process.arch === 'arm64' ? 'arm64' : 'x64'].sha256}`;

/** Count work without retaining audio, transcript text, or private reasoning. */
async function modelRequest(
  client: ACPClient,
  operation: () => Promise<string>,
  event: Diagnostic,
  diagnostic: (event: Diagnostic) => void = log,
  onQuotaExhausted?: () => void,
): Promise<string> {
  const started = Date.now();
  let output: string | undefined;
  let code: string | undefined;
  try {
    output = await operation();
    return output;
  } catch (error) {
    code = failure(error).code;
    if (code === 'quota_exhausted') onQuotaExhausted?.();
    throw error;
  } finally {
    diagnostic({
      ...event,
      event: 'model_request',
      elapsedMs: Date.now() - started,
      outputTextBytes:
        output === undefined ? undefined : Buffer.byteLength(output),
      thoughtChunks: client.diagnostics.thoughtChunks,
      thoughtBytes: client.diagnostics.thoughtBytes,
      code,
    });
  }
}

export async function processJob(
  store: TranscriptionStore,
  job: Job,
  config: WorkerConfig,
  pool: SessionPool,
  signal: AbortSignal,
  diagnostic: (event: Diagnostic) => void = log,
  media = { resolveMedia, downloadAudio },
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
    const started = performance.now();
    const url = await media.resolveMedia(job.shiur_id, job.source_url, signal);
    await media.downloadAudio(url, source, signal);
    const downloaded = performance.now();
    await store.stage(job, 'preparing');
    const info = await inspectAudio(source, signal);
    const audioHash = await hashFile(source, signal);
    const inspected = performance.now();
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
    performanceSample('audio_preparation', {
      attempt: job.attempt,
      downloadMs: downloaded - started,
      inspectMs: inspected - downloaded,
      prepareMs: performance.now() - inspected,
      bytes: info.bytes,
      ranges: ranges.length,
    });
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
            const prompt = transcriptionPrompt(
              job.skill_text,
              job.settings,
              name,
              input.index,
              input.total,
            );
            const bytes = await readFile(audio.path);
            return modelRequest(
              client,
              () =>
                client.prompt(prompt, bytes, audio.mimeType, input.timeoutMs),
              {
                event: 'model_request',
                job: job.id,
                model: job.model,
                kind: 'transcription',
                chunk: input.index,
                audioSeconds: input.range.end - input.range.start,
                audioBytes: bytes.length,
                inputTextBytes: Buffer.byteLength(prompt),
              },
              diagnostic,
              config.onQuotaExhausted,
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
    await store.complete(job, transcript, config.notes);
    diagnostic({ event: 'completed', job: job.id });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Heartbeat failure cancels owned work; losing a lease can never publish a transcript. */
export async function runLeasedJob<T>(
  store: {
    heartbeat: (job: T) => Promise<void>;
    finishFailure: (job: T, code: string, shutdown: boolean) => Promise<void>;
  },
  job: T,
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
      } catch (error) {
        const e = failure(error);
        controller.abort(
          e.code === 'storage_exhausted' ? e : new Failure('lease_lost'),
        );
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
    await store
      .finishFailure(
        job,
        code,
        signal.aborted ||
          ['quota_exhausted', 'storage_exhausted'].includes(code),
      )
      .catch(() => {});
    throw new Failure(code);
  } finally {
    stopHeartbeat.abort();
    await heartbeat;
  }
}

export async function processNotesJob(
  store: NotesStore,
  job: NotesJob,
  config: WorkerConfig,
  signal: AbortSignal,
  pool = new SessionPool(config.concurrency),
) {
  const profileInput = {
    model: job.model,
    language: job.language,
    runtime: job.runtime,
    transcriptionSkill: job.transcription_skill,
    notesSkill: job.notes_skill,
  };
  let p = notesProfile(profileInput);
  if (p.id !== job.version_id) p = notesProfile(profileInput, 'notes-1');
  if (p.id !== job.version_id || p.runtime !== runtimeIdentity())
    throw new Failure('configuration');
  const result = await generateNotes({
    profile: p,
    source: job.source,
    cleaned: job.cleaned_text,
    signal,
    saveCleaned: (text) => store.saveCleaned(job, text),
    request: (prompt) =>
      pool.run(signal, () =>
        withRuntime(config.runtime, signal, async (client, workspace) => {
          await client.authenticate();
          await client.session(workspace, job.model);
          return modelRequest(
            client,
            () => client.textPrompt(prompt),
            {
              event: 'model_request',
              job: job.id,
              model: job.model,
              kind: prompt.includes('<transcription-contract>')
                ? 'cleanup'
                : prompt.includes('<draft-notes>')
                  ? 'notes_repair'
                  : 'notes',
              inputTextBytes: Buffer.byteLength(prompt),
            },
            log,
            config.onQuotaExhausted,
          );
        }),
      ),
  });
  await store.complete(job, result.markdown);
  log({ event: 'notes_completed', job: job.id });
}

export async function runWorker(
  store: TranscriptionStore,
  config: WorkerConfig,
  signal: AbortSignal,
): Promise<void> {
  const pool = new SessionPool(config.concurrency);
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
      if (entry.isDirectory() && /^(job|acp)-[A-Za-z0-9]+$/.test(entry.name)) {
        if (entry.name.startsWith('acp-'))
          await recoverConversations(
            config.runtime.profile,
            join(config.runtime.scratch, entry.name),
          );
        await rm(join(config.runtime.scratch, entry.name), { recursive: true });
      }
    }
    await pruneConversations(config.runtime.profile);
    const models = await withRuntime(
      config.runtime,
      combined,
      async (client, workspace) => {
        await client.authenticate();
        return client.session(workspace, config.model);
      },
    );
    checkAbort(combined);
    config.onReady?.(models, pool);
    if (config.catalog) {
      catalogTask = pollSelections(
        store,
        config.catalog.profile,
        AbortSignal.any([combined, catalogStop.signal]),
        config.catalog.intervalMs,
        log,
      );
    }
    const notesStore = config.notes ? new NotesStore(store.pool) : undefined;
    const wake = workWake(store.pool);
    let nextNotesScan = 0;
    let nextProbe = 0;
    let idleMs = Math.max(5000, config.pollMs);
    let claimQueue = Promise.resolve();
    let preferTranscription = true;
    const claim = async () => {
      const previous = claimQueue;
      let release!: () => void;
      claimQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (Date.now() < nextProbe) return null;
        if (notesStore && config.notes) {
          if (Date.now() >= nextNotesScan) {
            await notesStore.enqueueMissing(config.notes, config.selectedOnly);
            nextNotesScan = Date.now() + 15 * 60_000;
          }
          // Alternate successful admissions while both queues have work.
          // A single lane remains fair; idle capacity belongs to either queue.
          if (preferTranscription) {
            const job = await store.claim(config.selectedOnly);
            if (job) {
              preferTranscription = false;
              return { job };
            }
          }
          const notes = await notesStore.claim(config.selectedOnly);
          if (notes) {
            preferTranscription = true;
            return { notes };
          }
        }
        const job = await store.claim(config.selectedOnly);
        if (job) {
          preferTranscription = false;
          return { job };
        }
        nextProbe = Date.now() + idleMs;
        idleMs = Math.min(10 * 60_000, idleMs * 2);
        return null;
      } finally {
        release();
      }
    };
    const lane = async () => {
      while (!combined.aborted) {
        const observed = wake.revision;
        const claimed = await claim();
        if (!claimed) {
          await wake.wait(
            Math.max(1000, nextProbe - Date.now()),
            combined,
            observed,
          );
          if (wake.revision !== observed) {
            nextProbe = 0;
            idleMs = Math.max(5000, config.pollMs);
          }
          continue;
        }
        nextProbe = 0;
        idleMs = Math.max(5000, config.pollMs);
        // Check leadership when admitting work; the socket error also aborts active jobs.
        await leader.query('SELECT 1');
        if ('notes' in claimed && notesStore) {
          const notesJob = claimed.notes;
          if (notesJob) {
            try {
              await runLeasedJob(notesStore, notesJob, combined, (s) =>
                processNotesJob(notesStore, notesJob, config, s, pool),
              );
            } catch (error) {
              const e = failure(error);
              log({ event: 'notes_failed', job: notesJob.id, code: e.code });
              if (
                [
                  'auth_required',
                  'configuration',
                  'lease_lost',
                  'quota_exhausted',
                  'storage_exhausted',
                ].includes(e.code) &&
                !combined.aborted
              )
                throw e;
            }
            continue;
          }
        }
        checkAbort(combined);
        if (!claimed.job) continue;
        const job = claimed.job;
        log({ event: 'claimed', job: job.id, attempt: job.attempt });
        try {
          await runLeasedJob(store, job, combined, (s) =>
            processJob(store, job, config, pool, s, log, config.media),
          );
        } catch (error) {
          const e = failure(error);
          log({ event: 'job_failed', job: job.id, code: e.code });
          if (
            [
              'auth_required',
              'configuration',
              'lease_lost',
              'quota_exhausted',
              'storage_exhausted',
            ].includes(e.code) &&
            !combined.aborted
          )
            throw e;
        }
      }
    };
    // Short recordings can run together; a long recording's parallel chunks and
    // all notes requests still acquire permits from this same five-session pool.
    // Drain every lane before scratch cleanup or releasing the leadership lock.
    await Promise.all(
      Array.from({ length: pool.limit }, () =>
        lane().catch((error) => {
          lost.abort(failure(error));
        }),
      ),
    );
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
