import { setTimeout as delay } from 'node:timers/promises';
import { SessionPool } from '../../antigravity-acp/src/pool.js';
import {
  checkAbort,
  failure,
  Failure,
} from '../../antigravity-acp/src/errors.js';
import type { Range, Segment, Settings, Transcript } from './types.js';
import type { Checkpoints } from './store.js';
import { mergeChunks, parseTranscript } from './transcript.js';

export type TranscribeChunk = (input: {
  range: Range;
  index: number;
  total: number;
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<string>;
export const chunkTimeout = (durationSeconds: number) =>
  Math.max(900_000, Math.min(7_200_000, durationSeconds * 3000));

/** Accepted chunks are durable before a lane advances, even when siblings fail. */
export async function transcribeChunks(input: {
  ranges: Range[];
  durationMs: number;
  settings: Settings;
  checkpoints: Checkpoints;
  pool: SessionPool;
  signal: AbortSignal;
  transcribe: TranscribeChunk;
  retryDelayMs?: number;
  onMerging?: () => Promise<void>;
  diagnostic?: (event: {
    chunk: number;
    attempt: number;
    elapsedMs: number;
    code: string;
  }) => void;
}): Promise<Transcript> {
  const abort = new AbortController();
  const signal = AbortSignal.any([input.signal, abort.signal]);
  const results: Segment[][] = Array.from(
    { length: input.ranges.length },
    () => [],
  );
  let next = 0;
  let firstError: unknown;
  const lane = async () => {
    try {
      while (next < input.ranges.length) {
        checkAbort(signal);
        const index = next++,
          range = input.ranges[index];
        const saved = await input.checkpoints.load(index, range);
        if (saved) {
          results[index] = saved;
          continue;
        }
        for (let attempt = 1; attempt <= 2; attempt++) {
          const started = Date.now();
          let segments: Segment[];
          try {
            const output = await input.pool.run(signal, async () => {
              const timeoutMs = chunkTimeout(range.end - range.start);
              const controller = new AbortController();
              const timer = setTimeout(
                () => controller.abort(new Failure('timeout')),
                timeoutMs,
              );
              try {
                return await input.transcribe({
                  range,
                  index,
                  total: input.ranges.length,
                  signal: AbortSignal.any([signal, controller.signal]),
                  timeoutMs,
                });
              } finally {
                clearTimeout(timer);
              }
            });
            checkAbort(signal);
            segments = parseTranscript(
              output,
              Math.round((range.end - range.start) * 1000),
              input.settings,
            );
          } catch (error) {
            checkAbort(signal);
            const e = failure(error);
            input.diagnostic?.({
              chunk: index,
              attempt,
              elapsedMs: Date.now() - started,
              code: e.code,
            });
            if (attempt === 1 && ['process_exit', 'timeout'].includes(e.code)) {
              await delay(input.retryDelayMs ?? 1000, undefined, { signal });
              continue;
            }
            throw e;
          }
          try {
            await input.checkpoints.save(index, range, segments);
          } catch (error) {
            const e = failure(error);
            throw error instanceof Failure || e.code === 'storage_exhausted'
              ? e
              : new Failure('checkpoint');
          }
          results[index] = segments;
          break;
        }
      }
    } catch (e) {
      firstError ??= e;
      abort.abort(e);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(input.pool.limit, input.ranges.length) },
      lane,
    ),
  );
  if (firstError) throw firstError;
  checkAbort(signal);
  await input.onMerging?.();
  return mergeChunks(input.ranges, results, input.durationMs);
}
