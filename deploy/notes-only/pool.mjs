import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';

/** Check host headroom before starting another native runtime. */
export function createMemoryAdmission({
  minAvailableMiB = 0,
  readMemory = () => readFileSync('/proc/meminfo', 'utf8'),
  log = (value) => console.log(JSON.stringify(value)),
} = {}) {
  if (!Number.isInteger(minAvailableMiB) || minAvailableMiB < 0)
    throw new Error('Minimum available memory must be a nonnegative integer.');
  let waiting = false;
  return () => {
    if (!minAvailableMiB) return true;
    let availableMiB = null;
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readMemory());
      if (match) availableMiB = Math.floor(Number(match[1]) / 1024);
    } catch {
      // An unreadable memory budget must not admit another process.
    }
    const allowed = availableMiB !== null && availableMiB >= minAvailableMiB;
    if (waiting !== !allowed) {
      log({
        status: allowed ? 'memory_admission_resumed' : 'waiting_for_memory',
        availableMiB,
        minAvailableMiB,
      });
      waiting = !allowed;
    }
    return allowed;
  };
}

function errorMessage(error, secrets) {
  let message = String(error.message ?? 'Unknown error');
  for (const secret of secrets)
    if (secret) message = message.replaceAll(String(secret), '[REDACTED]');
  return message
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL REDACTED]')
    .replace(
      /(["']?(?:password|passwd|secret|token|api[_-]?key|authorization|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 300);
}

/** One queue owner; each active job owns a separate transcript and ACP session. */
export async function runNotesPool({
  queue,
  processJob,
  signal,
  concurrency = 6,
  limit = Infinity,
  follow = false,
  runUntil = Infinity,
  paceMs = 2000,
  log = (value) => console.log(JSON.stringify(value)),
  now = Date.now,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
  secrets = [],
  canAdmit = () => true,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10)
    throw new Error('Concurrency must be between 1 and 10.');
  const active = new Map();
  let processed = 0;
  let retried = 0;
  let failed = false;
  let stopped = false;
  let nextStartAt = 0;
  let nextPollAt = 0;
  const accept = ({ job, status, error }) => {
    active.delete(job.id);
    if (!error) {
      processed++;
      log({ id: job.id, status, processed, active: active.size });
      return;
    }
    const code =
      error.code ??
      (error.status ? `database_${error.status}` : 'processing_failed');
    const message = errorMessage(error, secrets);
    if (
      code === 'invalid_transcript' ||
      /conflict|checksum|version/i.test(error.message ?? '')
    ) {
      queue.blocked(job.id, code);
      processed++;
      log({
        id: job.id,
        status: 'blocked',
        code,
        message,
        active: active.size,
      });
      return;
    }
    const retryAfterMs = Number(error.retryAfterMs);
    const after = Math.max(
      Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0,
      Math.min(6 * 3600000, 60000 * 2 ** Math.min(job.attempts, 9)),
    );
    queue.retry(job.id, code, after);
    retried++;
    log({
      id: job.id,
      status: 'retry',
      code,
      message,
      retryAfterMs: after,
      active: active.size,
    });
    if (!signal.aborted) {
      // A shared cooldown prevents all lanes from hammering an exhausted provider.
      const status = Number(
        error.status ?? error.statusCode ?? error.response?.status,
      );
      const providerCooldown =
        code === 'quota_exhausted' ||
        status === 429 ||
        status === 503 ||
        error.retryAfterMs != null ||
        error.retryAfter != null ||
        error.headers?.get?.('Retry-After') != null ||
        error.response?.headers?.get?.('Retry-After') != null;
      if (providerCooldown) {
        nextStartAt = Math.max(nextStartAt, now() + after);
        if (!follow) stopped = true;
      }
      if (!follow) failed = true;
    }
  };
  try {
    while (true) {
      // Bounded pilots count attempted retries against their limit, while a
      // following queue can keep running until it reaches its terminal limit.
      const settled = processed + (follow ? 0 : retried);
      const admitting =
        !signal.aborted && !stopped && settled < limit && now() < runUntil;
      let empty = false;
      if (
        admitting &&
        settled + active.size < limit &&
        active.size < concurrency &&
        now() >= Math.max(nextStartAt, nextPollAt)
      ) {
        if (!canAdmit()) {
          nextPollAt = now() + 5000;
        } else {
          queue.recheckMissing();
          const job = queue.claim();
          if (job) {
            const pending = Promise.resolve()
              .then(() => processJob(job))
              .then(
                (status) => ({ job, status }),
                (error) => ({ job, error }),
              );
            active.set(job.id, pending);
            nextStartAt = now() + paceMs;
            nextPollAt = 0;
            log({
              id: job.id,
              status: 'started',
              active: active.size,
              concurrency,
            });
            continue;
          }
          empty = true;
          nextPollAt = now() + 60000;
        }
      }
      if (!active.size && (!admitting || (empty && !follow))) break;
      const canStart =
        admitting &&
        active.size < concurrency &&
        settled + active.size < limit &&
        (follow || !empty);
      const wakeAt = Math.min(
        admitting ? runUntil : Infinity,
        canStart ? Math.max(nextStartAt, nextPollAt) : Infinity,
      );
      if (wakeAt === Infinity && active.size) {
        accept(await Promise.race(active.values()));
        nextPollAt = 0;
        continue;
      }
      const waiting = new AbortController();
      const cancel = () => waiting.abort();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (signal.aborted) waiting.abort();
        const outcome = await Promise.race([
          ...active.values(),
          sleep(Math.max(0, wakeAt - now()), waiting.signal).then(
            () => null,
            (error) => {
              if (waiting.signal.aborted) return null;
              throw error;
            },
          ),
        ]);
        if (outcome) {
          accept(outcome);
          nextPollAt = 0;
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        waiting.abort();
      }
    }
  } finally {
    // Never close SQLite or release the mutation lock while sessions are active.
    await Promise.allSettled(active.values());
  }
  return { processed, failed };
}
