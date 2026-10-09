import { setTimeout as delay } from 'node:timers/promises';

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
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6)
    throw new Error('Concurrency must be between 1 and 6.');
  const active = new Map();
  let processed = 0;
  let failed = false;
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
    if (/conflict|checksum|version/i.test(error.message ?? '')) {
      queue.blocked(job.id, code);
      processed++;
      log({ id: job.id, status: 'blocked', code, active: active.size });
      return;
    }
    const after = Math.max(
      error.retryAfterMs ?? 0,
      Math.min(6 * 3600000, 60000 * 2 ** Math.min(job.attempts, 9)),
    );
    queue.retry(job.id, code, after);
    log({
      id: job.id,
      status: 'retry',
      code,
      retryAfterMs: after,
      active: active.size,
    });
    if (!signal.aborted) {
      // A shared cooldown prevents six lanes from hammering an exhausted provider.
      nextStartAt = Math.max(nextStartAt, now() + after);
      if (!follow) failed = true;
    }
  };
  try {
    while (true) {
      const admitting =
        !signal.aborted && !failed && processed < limit && now() < runUntil;
      let empty = false;
      if (
        admitting &&
        processed + active.size < limit &&
        active.size < concurrency &&
        now() >= Math.max(nextStartAt, nextPollAt)
      ) {
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
      if (!active.size && (!admitting || (empty && !follow))) break;
      const canStart =
        admitting &&
        active.size < concurrency &&
        processed + active.size < limit &&
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
