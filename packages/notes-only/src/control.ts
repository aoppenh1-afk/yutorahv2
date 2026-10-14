import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { NotesQueue, NoteJob } from './queue.js';

export class PipelineFailure extends Error {
  constructor(
    readonly code: string,
    readonly upstream: 'muse' | 'yutorah' | 'tidb' = 'muse',
    readonly retryAfterMs = 0,
    readonly pause = false,
  ) {
    super(code);
  }
}
export function retryAfter(value: unknown, now = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.max(0, value);
  if (typeof value !== 'string') return 0;
  const number = Number(value);
  const ms =
    value.trim() !== '' && Number.isFinite(number)
      ? number * 1000
      : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}
export function classify(
  error: unknown,
  upstream: 'muse' | 'yutorah' | 'tidb',
) {
  if (error instanceof PipelineFailure) return error;
  const e = error as {
    code?: string;
    status?: number;
    message?: string;
    retryAfterMs?: number;
    retryAfter?: string;
  };
  const code = e?.code ?? '';
  const text = String(e?.message ?? '');
  if ((error as Error)?.name === 'AbortError')
    return new PipelineFailure('cancelled', upstream);
  if (
    [
      'configuration',
      'auth_required',
      'paid_route',
      'unconfirmed_identity',
      'session_uncertain',
    ].includes(code)
  )
    return new PipelineFailure(code, upstream, 0, true);
  if (e?.status === 401 || e?.status === 403)
    return new PipelineFailure('authentication', upstream, 0, true);
  if (
    /access denied|authentication failed|invalid credentials|permission denied/i.test(
      text,
    )
  )
    return new PipelineFailure('authentication', upstream, 0, true);
  if (code === 'invalid_transcript')
    return new PipelineFailure(code, 'yutorah');
  if (
    code === 'incomplete_output' ||
    code === 'off_task' ||
    code === 'lease_lost' ||
    code === 'cancelled'
  )
    return new PipelineFailure(code, upstream);
  if (
    code === 'quota_exhausted' ||
    /quota.*(?:exhaust|exceed)|usage limit reached|FreeTierError/i.test(text)
  )
    return new PipelineFailure(
      'quota_exhausted',
      upstream,
      retryAfter(e.retryAfterMs ?? e.retryAfter) || 3600_000,
    );
  if (e?.status === 429 || e?.status === 503 || /\b(?:429|503)\b/.test(text))
    return new PipelineFailure(
      'throttled',
      upstream,
      retryAfter(e.retryAfterMs ?? e.retryAfter) || 60_000,
    );
  if (
    code === 'ETIMEDOUT' ||
    code === 'timeout' ||
    (error as Error)?.name === 'TimeoutError'
  )
    return new PipelineFailure('timeout', upstream);
  return new PipelineFailure('transient', upstream);
}
export const backoff = (attempt: number, random = Math.random) =>
  Math.min(3600_000, 1000 * 2 ** Math.min(attempt, 11)) *
  (0.75 + random() * 0.5);
export type RequestEvidence = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  identity: string;
  helperRequests?: number;
};
/** All runtimes and repairs share one durable request/token budget. Limits are local controls, not provider quotas. */
export class InferenceLimiter {
  private nextStart = 0;
  private active = 0;
  constructor(
    readonly queue: NotesQueue,
    readonly config: {
      concurrency: number;
      spacingMs: number;
      requestsPerMinute: number;
      tokensPerMinute: number;
      outputReservation: number;
    },
  ) {}
  async run<T>(
    job: NoteJob,
    route: string,
    kind: string,
    prompt: string,
    signal: AbortSignal,
    operation: (id: string) => Promise<{ value: T; evidence: RequestEvidence }>,
  ) {
    const reservation =
      Buffer.byteLength(prompt) + this.config.outputReservation;
    if (
      reservation > this.config.tokensPerMinute ||
      Buffer.byteLength(prompt) > 1024 * 1024
    )
      throw new PipelineFailure('input_budget', 'muse');
    let id: string;
    for (;;) {
      signal.throwIfAborted();
      if (!this.queue.owns(job)) throw new PipelineFailure('lease_lost');
      if (!this.queue.available('muse'))
        throw new PipelineFailure('route_paused');
      const now = Date.now();
      const used = this.queue.db
        .prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN input_tokens IS NULL THEN reserved_tokens
        ELSE MAX(reserved_tokens,input_tokens+output_tokens+reasoning_tokens+cache_read_tokens+cache_write_tokens) END),0) AS tokens
        FROM requests WHERE started_at>?`)
        .get(now - 60_000)!;
      if (
        this.active < this.config.concurrency &&
        now >= this.nextStart &&
        Number(used.count) < this.config.requestsPerMinute &&
        Number(used.tokens) + reservation <= this.config.tokensPerMinute
      ) {
        id = randomUUID();
        this.active++;
        this.nextStart = now + this.config.spacingMs;
        this.queue.db
          .prepare(
            "INSERT INTO requests(id,job_id,token,route,kind,started_at,status,reserved_tokens) VALUES(?,?,?,?,?,?,'active',?)",
          )
          .run(id, job.id, job.lease_token, route, kind, now, reservation);
        break;
      }
      await delay(100, undefined, { signal });
    }
    try {
      const result = await operation(id);
      if (result.evidence.cost !== 0)
        throw new PipelineFailure('paid_route', 'muse', 0, true);
      const e = result.evidence;
      this.queue.db
        .prepare(
          `UPDATE requests SET ended_at=?,status='completed',input_tokens=?,output_tokens=?,reasoning_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cost=?,evidence=? WHERE id=?`,
        )
        .run(
          Date.now(),
          e.input,
          e.output,
          e.reasoning,
          e.cacheRead,
          e.cacheWrite,
          e.cost,
          e.identity,
          id,
        );
      for (let helper = 0; helper < (e.helperRequests ?? 0); helper++)
        this.queue.db
          .prepare(`INSERT INTO requests(id,job_id,token,route,kind,started_at,ended_at,status,reserved_tokens,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,cost,evidence)
        VALUES(?,?,?,?, 'helper',?,?,'observed',0,0,0,0,0,0,0,?)`)
          .run(
            randomUUID(),
            job.id,
            job.lease_token,
            route,
            Date.now(),
            Date.now(),
            e.identity,
          );
      return result.value;
    } catch (error) {
      const e = classify(error, 'muse');
      this.queue.db
        .prepare('UPDATE requests SET ended_at=?,status=? WHERE id=?')
        .run(Date.now(), e.code, id);
      if (e.pause || e.retryAfterMs)
        this.queue.cooldown('muse', e.retryAfterMs, e.code, e.pause);
      throw e;
    } finally {
      this.active--;
    }
  }
}
