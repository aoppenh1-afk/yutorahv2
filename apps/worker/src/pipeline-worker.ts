import { setTimeout as delay } from 'node:timers/promises';
import {
  failure,
  checkAbort,
} from '../../../packages/antigravity-acp/src/errors.js';
import { type TranscriptionStore } from '../../../packages/transcription/src/store.js';
import { runWorker, log, type WorkerConfig } from './worker.js';
import { runNotesWorker } from './notes-worker.js';

/** CLI orchestration: only Google's loop waits for Google's five-hour allowance. */
export async function runPipelineWorker(
  store: TranscriptionStore,
  config: WorkerConfig & { notesConcurrency?: number },
  signal: AbortSignal,
): Promise<void> {
  if (!config.openCode || !config.notes)
    return runWorker(store, config, signal);
  const fatal = new AbortController();
  const combined = AbortSignal.any([signal, fatal.signal]);
  const audio = async () => {
    while (!combined.aborted) {
      let detectedAt: number | undefined;
      try {
        await runWorker(
          store,
          {
            ...config,
            onQuotaExhausted: () => {
              detectedAt ??= Date.now();
              config.onQuotaExhausted?.();
            },
          },
          combined,
        );
      } catch (error) {
        const e = failure(error);
        if (e.code !== 'quota_exhausted' || combined.aborted) throw e;
        const remaining = Math.max(
          0,
          (detectedAt ?? Date.now()) + 301 * 60_000 - Date.now(),
        );
        log({ event: 'transcription_waiting_quota', code: e.code });
        await delay(remaining, undefined, { signal: combined }).catch(() =>
          checkAbort(combined),
        );
      }
    }
  };
  const notes = async () => {
    try {
      await runNotesWorker(
        store,
        {
          ...config,
          openCode: config.openCode!,
          notes: config.notes!,
          concurrency: config.notesConcurrency ?? 2,
        },
        combined,
      );
    } catch (error) {
      const e = failure(error);
      if (
        combined.aborted ||
        ['lease_lost', 'storage_exhausted'].includes(e.code)
      )
        throw e;
      // A notes-provider failure is reported while audio can keep progressing.
      log({ event: 'notes_worker_stopped', code: e.code });
      await new Promise<void>((resolve) => {
        if (combined.aborted) resolve();
        else
          combined.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  };
  await Promise.all(
    [audio, notes].map(async (run) => {
      try {
        await run();
      } catch (error) {
        fatal.abort(failure(error));
      }
    }),
  );
  if (!signal.aborted && fatal.signal.aborted) throw fatal.signal.reason;
  checkAbort(signal);
}
