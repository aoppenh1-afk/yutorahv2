import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type PoolClient } from 'pg';
import { SessionPool } from '../../../packages/antigravity-acp/src/pool.js';
import {
  Failure,
  failure,
  checkAbort,
} from '../../../packages/antigravity-acp/src/errors.js';
import { NotesStore } from '../../../packages/transcription/src/notes-store.js';
import { type TranscriptionStore } from '../../../packages/transcription/src/store.js';
import { workWake } from '../../../packages/transcription/src/work-wake.js';
import { type NotesProfile } from '../../../packages/transcription/src/notes.js';
import {
  recoverOpenCode,
  withOpenCode,
  type OpenCodeConfig,
} from '../../../packages/opencode-acp/src/runtime.js';
import {
  processNotesJob,
  runLeasedJob,
  log,
  type WorkerConfig,
} from './worker.js';

export type NotesWorkerStatus = {
  state: 'starting' | 'running' | 'waiting_quota' | 'stopped' | 'error';
  model: string;
  concurrency: number;
  activeSessions: number;
  resumeAt: string | null;
  error: string | null;
};
export type NotesWorkerConfig = WorkerConfig & {
  notes: NotesProfile;
  openCode: OpenCodeConfig;
  onStatus?: (status: NotesWorkerStatus) => void;
};

/** A separate leader and session pool keep notes independent of Google quota. */
export async function runNotesWorker(
  store: TranscriptionStore,
  config: NotesWorkerConfig,
  signal: AbortSignal,
): Promise<void> {
  if (!config.notes.runtime.startsWith('opencode:'))
    throw new Failure('configuration');
  const sessions = new SessionPool(config.concurrency);
  const notes = new NotesStore(store.pool);
  const leader: PoolClient = await store.pool.connect();
  const lost = new AbortController();
  const combined = AbortSignal.any([signal, lost.signal]);
  const loseLeadership = () => lost.abort(new Failure('lease_lost'));
  leader.on('error', loseLeadership);
  let retryAt = 0;
  let backoff = 60_000;
  let nextScan = 0;
  let nextProbe = 0;
  let idleMs = Math.max(5000, config.pollMs);
  let scanning: Promise<void> | undefined;
  const report = (error: string | null = null) =>
    config.onStatus?.({
      state: combined.aborted
        ? 'stopped'
        : retryAt > Date.now()
          ? 'waiting_quota'
          : 'running',
      model: config.notes.model,
      concurrency: sessions.limit,
      activeSessions: sessions.activeCount,
      resumeAt: retryAt > Date.now() ? new Date(retryAt).toISOString() : null,
      error,
    });
  try {
    const lock = await leader.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(891733,3) AS acquired',
    );
    if (!lock.rows[0]?.acquired) throw new Failure('configuration');
    await mkdir(config.openCode.scratch, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(config.openCode.scratch, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && /^opencode-[A-Za-z0-9]+$/.test(entry.name))
        await recoverOpenCode(
          config.openCode,
          join(config.openCode.scratch, entry.name),
          combined,
        );
    }
    // Verify installation, identity, free model and agent configuration before
    // admitting durable work. This performs no model inference.
    await withOpenCode(config.openCode, combined, (client, workspace) =>
      client.session(workspace, config.notes.model),
    );
    const wake = workWake(store.pool);
    report();
    const lane = async () => {
      while (!combined.aborted) {
        const observed = wake.revision;
        const admitAt = Math.max(retryAt, nextProbe);
        if (Date.now() < admitAt) {
          await wake.wait(
            Math.max(1000, admitAt - Date.now()),
            combined,
            observed,
          );
          if (wake.revision !== observed) {
            nextProbe = 0;
            idleMs = Math.max(5000, config.pollMs);
            nextScan = 0;
          }
          continue;
        }
        if (Date.now() >= nextScan) {
          scanning ??= notes
            .enqueueMissing(config.notes, config.selectedOnly)
            .finally(() => {
              scanning = undefined;
              nextScan = Date.now() + 15 * 60_000;
            });
          await scanning;
        }
        const job = await notes.claim(config.selectedOnly, 'opencode:');
        if (!job) {
          nextProbe = Date.now() + idleMs;
          idleMs = Math.min(10 * 60_000, idleMs * 2);
          continue;
        }
        nextProbe = 0;
        idleMs = Math.max(5000, config.pollMs);
        checkAbort(combined);
        await leader.query('SELECT 1');
        try {
          await runLeasedJob(notes, job, combined, (jobSignal) =>
            sessions.run(jobSignal, async () => {
              report();
              await processNotesJob(notes, job, config, jobSignal);
            }),
          );
          backoff = 60_000;
        } catch (error) {
          const e = failure(error);
          log({ event: 'notes_failed', job: job.id, code: e.code });
          if (e.code === 'quota_exhausted') {
            retryAt = Math.max(retryAt, Date.now() + backoff);
            backoff = Math.min(15 * 60_000, backoff * 2);
            report(e.code);
          } else if (
            [
              'auth_required',
              'configuration',
              'lease_lost',
              'storage_exhausted',
            ].includes(e.code) &&
            !combined.aborted
          ) {
            throw e;
          } else {
            // Authentication/configuration failures are visible on the job,
            // without stopping audio transcription or falling back to Gemini.
            report(e.code);
          }
        } finally {
          report(retryAt > Date.now() ? 'quota_exhausted' : null);
        }
      }
    };
    await Promise.all(
      Array.from({ length: sessions.limit }, () =>
        lane().catch((error) => {
          lost.abort(failure(error));
        }),
      ),
    );
    checkAbort(combined);
  } finally {
    report();
    leader.removeListener('error', loseLeadership);
    await leader.query('SELECT pg_advisory_unlock(891733,3)').catch(() => {});
    leader.release();
  }
}
