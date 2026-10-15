import { readFile, statfs } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { NotesQueue, NoteJob, Stage } from './queue.js';
import type { NotesPipeline } from './pipeline.js';
import { classify, backoff, MAX_AI_CONCURRENCY } from './control.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
export const SOURCE_RESERVATION = 8 * 1024 * 1024;
export const OUTBOX_RESERVATION = 272 * 1024;
export type PoolSettings = {
  fetchers: number;
  generators: number;
  publishers: number;
  leaseMs: number;
  readyLow: number;
  readyTarget: number;
  readyMax: number;
  sourceBytes: number;
  outboxCount: number;
  outboxBytes: number;
  quarantineCount: number;
  quarantineBytes: number;
  diskReserveBytes: number;
  minFreeMemoryMiB: number;
  inventoryPaceMs: number;
  fetchSpacingMs: number;
};
export const defaults: PoolSettings = {
  fetchers: 3,
  generators: 4,
  publishers: 1,
  leaseMs: 120_000,
  readyLow: 20,
  readyTarget: 50,
  readyMax: 100,
  sourceBytes: 1024 ** 3,
  outboxCount: 1000,
  outboxBytes: 1024 ** 3,
  quarantineCount: 10000,
  quarantineBytes: 1024 ** 3,
  diskReserveBytes: 2 * 1024 ** 3,
  minFreeMemoryMiB: 3072,
  inventoryPaceMs: 1000,
  fetchSpacingMs: 250,
};
export async function availableMemoryMiB() {
  const value = (await readFile('/proc/meminfo', 'utf8')).match(
    /^MemAvailable:\s+(\d+)/m,
  );
  if (!value) throw new Error('Cannot read available memory.');
  return Number(value[1]) / 1024;
}
export async function diskHeadroom(root: string) {
  const d = await statfs(root);
  return Number(d.bavail) * Number(d.bsize);
}
export function metrics(queue: NotesQueue, since = Date.now() - 3600_000) {
  since = Math.max(since, queue.cursor('regenerationStartedAt'));
  const events = queue.db
    .prepare(
      'SELECT stage,outcome,duration_ms,at FROM events WHERE at>=? ORDER BY at',
    )
    .all(since);
  const stages: Record<
    string,
    { count: number; p50Ms: number; p95Ms: number }
  > = {};
  for (const stage of [
    'fetching',
    'generating',
    'publishing',
    'ready_wait',
    'artifact_commit',
  ]) {
    const durations = events
      .filter((e) => e.stage === stage)
      .map((e) => Number(e.duration_ms))
      .sort((a, b) => a - b);
    stages[stage] = {
      count: durations.length,
      p50Ms: durations[Math.floor((durations.length - 1) * 0.5)] ?? 0,
      p95Ms: durations[Math.floor((durations.length - 1) * 0.95)] ?? 0,
    };
  }
  const publications = events.filter(
    (e) => e.stage === 'publishing' && e.outcome === 'completed',
  ).length;
  const now = Date.now();
  const observedMs = Math.max(1, now - since);
  const timings = queue.db
    .prepare(`SELECT o.phase,o.duration_ms,r.status,r.kind FROM request_observations o
    LEFT JOIN requests r ON r.id=o.request_id WHERE o.at>=? AND o.phase NOT IN ('request_sent','prompt_bytes')`)
    .all(since);
  const percentile = (values: number[], fraction: number) => {
    values.sort((a, b) => a - b);
    return values[Math.floor((values.length - 1) * fraction)] ?? 0;
  };
  const requestTimings = Object.fromEntries(
    [...new Set(timings.map((r) => String(r.phase)))].map((phase) => {
      const rows = timings.filter((r) => r.phase === phase);
      const values = rows.map((r) => Number(r.duration_ms));
      return [
        phase,
        {
          count: values.length,
          p50Ms: percentile(values, 0.5),
          p95Ms: percentile(values, 0.95),
          byOutcome: Object.fromEntries(
            [...new Set(rows.map((r) => String(r.status ?? 'pending')))].map(
              (status) => {
                const samples = rows
                  .filter((r) => String(r.status ?? 'pending') === status)
                  .map((r) => Number(r.duration_ms));
                return [
                  status,
                  {
                    count: samples.length,
                    p50Ms: percentile(samples, 0.5),
                    p95Ms: percentile(samples, 0.95),
                  },
                ];
              },
            ),
          ),
        },
      ];
    }),
  );
  const publicationRates = Object.fromEntries(
    [
      ['fiveMinutes', 300000],
      ['sixtyMinutes', 3600000],
    ].map(([label, ms]) => {
      const start = Math.max(
        now - Number(ms),
        queue.cursor('regenerationStartedAt'),
      );
      const count = Number(
        queue.db
          .prepare(
            "SELECT COUNT(*) n FROM events WHERE stage='publishing' AND outcome='completed' AND at>=?",
          )
          .get(start)?.n ?? 0,
      );
      return [
        label,
        {
          count,
          observedMs: now - start,
          perHour: (count * 3600000) / Math.max(1, now - start),
        },
      ];
    }),
  );
  const quality = queue.db
    .prepare(`SELECT COUNT(*) samples,COALESCE(SUM(first_pass),0) firstPass
    FROM generation_attempts WHERE started_at>=? AND first_pass IS NOT NULL`)
    .get(since);
  return {
    since,
    observedMs,
    jobs: queue.status(),
    buffers: queue.usage(),
    stages,
    verifiedPublications: publications,
    verifiedPublicationsPerHour: (publications * 3600_000) / observedMs,
    publicationRates,
    requestTimings,
    firstPass: quality,
    validationFailures: queue.db
      .prepare(
        "SELECT outcome,COUNT(*) count FROM events WHERE stage='validation' AND at>=? GROUP BY outcome",
      )
      .all(since),
    activeProviderRequests: queue.db
      .prepare(`SELECT COUNT(*) count FROM requests r WHERE r.status='active'
      AND EXISTS(SELECT 1 FROM request_observations o WHERE o.request_id=r.id AND o.phase='request_sent')
      AND NOT EXISTS(SELECT 1 FROM request_observations o WHERE o.request_id=r.id AND o.phase='response_completed')`)
      .get()?.count,
    ready: queue.db
      .prepare(
        "SELECT COUNT(*) count,COALESCE(MIN(COALESCE(ready_at,updated_at)),0) oldestAt FROM jobs WHERE status='ready' AND eligibility='eligible' AND next_at<=?",
      )
      .get(now),
    publishable: queue.db
      .prepare(
        "SELECT COUNT(*) count,COALESCE(MIN(updated_at),0) oldestAt FROM jobs WHERE status IN ('generated','publishing') AND review IN ('approved_route','accepted')",
      )
      .get(),
    tokens: queue.db
      .prepare(`SELECT COUNT(*) requests,SUM(input_tokens) input,SUM(output_tokens) output,
      SUM(reasoning_tokens) reasoning,SUM(cache_read_tokens) cacheRead,SUM(cache_write_tokens) cacheWrite
      FROM requests WHERE started_at>=?`)
      .get(since),
    sourceHours: Number(
      queue.db
        .prepare(`SELECT COALESCE(SUM(a.source_seconds),0)/3600 hours FROM jobs j
      JOIN generation_artifacts g ON g.path=j.artifact_path JOIN generation_attempts a ON a.token=g.token
      WHERE j.status='completed' AND j.completed_at>=?`)
        .get(since)?.hours ?? 0,
    ),
    actualSessions: queue.db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE state='active'")
      .get()?.count,
    repairs: queue.db
      .prepare(
        "SELECT COUNT(*) AS count FROM requests WHERE kind='repair' AND started_at>=?",
      )
      .get(since)?.count,
    retries: queue.db
      .prepare(
        "SELECT outcome,COUNT(*) AS count FROM events WHERE at>=? AND stage IN ('fetching','generating','publishing') AND outcome NOT IN ('ready','generated','needs_review','completed','already_published') GROUP BY outcome",
      )
      .all(since),
    upstreams: queue.db.prepare('SELECT * FROM upstreams').all(),
  };
}
/** Independent continuously refilling pools. No network or model I/O occurs inside SQLite transactions. */
export async function runCoordinator(input: {
  root: string;
  queue: NotesQueue;
  pipeline: NotesPipeline;
  settings: PoolSettings;
  signal: AbortSignal;
  limit?: number;
  follow?: boolean;
  maxRuntimeMs?: number;
  inventory?: () => Promise<unknown>;
  inventoryDuringBoundedRun?: boolean;
  maintenance?: () => Promise<unknown>;
  log?: (record: unknown) => void;
  memory?: () => Promise<number>;
  disk?: () => Promise<number>;
  runtimeMetrics?: () => unknown;
}) {
  const { queue, pipeline, settings: s, signal } = input;
  if (
    !(s.readyLow <= s.readyTarget && s.readyTarget <= s.readyMax) ||
    s.sourceBytes < SOURCE_RESERVATION ||
    s.outboxBytes < OUTBOX_RESERVATION ||
    s.generators < 1 ||
    !Number.isSafeInteger(s.generators) ||
    s.generators > MAX_AI_CONCURRENCY ||
    s.leaseMs < 300
  )
    throw new Error('Invalid pool bounds.');
  const started = Date.now(),
    limit = input.limit ?? Infinity;
  const selected = new Set<string>();
  const finished = new Set<string>();
  const active = new Map<
    string,
    {
      stage: Stage;
      job: NoteJob;
      abort: AbortController;
      promise: Promise<void>;
    }
  >();
  const counts: Record<Stage, number> = {
    fetching: 0,
    generating: 0,
    publishing: 0,
  };
  const log = input.log ?? (() => {});
  const waiting = new Map<string, number>();
  const admission = (kind: string, allowed: boolean) => {
    if (!allowed && !waiting.has(kind)) {
      waiting.set(kind, Date.now());
      queue.event('admission', kind + '_wait', null);
      log({ stage: 'admission', reason: kind, status: 'waiting' });
    }
    if (allowed && waiting.has(kind)) {
      queue.event(
        'admission',
        kind + '_resumed',
        null,
        Date.now() - waiting.get(kind)!,
      );
      waiting.delete(kind);
      log({ stage: 'admission', reason: kind, status: 'resumed' });
    }
    return allowed;
  };
  let refilling = true,
    nextFetch = 0,
    sequence = 0,
    nextInventory = 0,
    inventory: Promise<void> | undefined,
    nextMetrics = 0,
    nextMaintenance = 0,
    maintenance: Promise<void> | undefined,
    nextRecovery = 0;
  const launch = (stage: Stage, job: NoteJob) => {
    selected.add(job.id);
    counts[stage]++;
    const abort = new AbortController();
    const jobSignal = AbortSignal.any([signal, abort.signal]);
    const timer = setInterval(
      () => {
        if (!queue.heartbeat(job, s.leaseMs)) abort.abort();
      },
      Math.max(100, Math.floor(s.leaseMs / 3)),
    );
    const before = Date.now();
    if (stage === 'generating' && job.ready_at)
      queue.event('ready_wait', 'claimed', job.id, before - job.ready_at);
    const promise = (async () => {
      try {
        const outcome = await pipeline[stage](job, jobSignal);
        if (
          [
            'completed',
            'missing',
            'already_published',
            'needs_review',
            'conflict',
          ].includes(outcome)
        )
          finished.add(job.id);
        queue.event(stage, outcome, job.id, Date.now() - before);
        log({ id: job.id, stage, outcome, ms: Date.now() - before });
      } catch (error) {
        const e = classify(
          error,
          stage === 'fetching'
            ? 'yutorah'
            : stage === 'publishing'
              ? 'tidb'
              : 'muse',
        );
        if (e.pause || e.retryAfterMs)
          queue.cooldown(e.upstream, e.retryAfterMs, e.code, e.pause);
        if (queue.owns(job)) {
          const permanent = [
            'invalid_transcript',
            'source_changed',
            'input_budget',
          ].includes(e.code);
          const review = [
            'incomplete_output',
            'off_task',
            'unexpected_hebrew',
            'language_source_unavailable',
          ].includes(e.code);
          queue.finish(job, {
            status: permanent
              ? 'blocked'
              : review
                ? 'needs_review'
                : stage === 'fetching'
                  ? job.source_path
                    ? 'ready'
                    : 'discovered'
                  : stage === 'generating'
                    ? 'ready'
                    : 'generated',
            error: e.code,
            next_at:
              Date.now() +
              (e.retryAfterMs ||
                backoff(
                  stage === 'fetching'
                    ? job.fetch_attempts
                    : stage === 'generating'
                      ? job.generation_attempts
                      : job.publication_attempts,
                )),
          });
          if (permanent || review) finished.add(job.id);
        }
        queue.event(stage, e.code, job.id, Date.now() - before);
        log({ id: job.id, stage, error: e.code });
        // Bounded runs count each selected job once even if it remains retryable.
        if (limit !== Infinity) finished.add(job.id);
      } finally {
        clearInterval(timer);
        counts[stage]--;
        active.delete(job.id);
      }
    })();
    active.set(job.id, { stage, job, abort, promise });
  };
  // Reconciliation is bounded to expired leases. A status command never resets live work.
  await pipeline.recoverExpired();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  try {
    while (!signal.aborted) {
      const now = Date.now();
      const admissions = now - started < (input.maxRuntimeMs ?? Infinity);
      if (now >= nextRecovery) {
        for (const expired of queue.expired()) {
          const running = active.get(expired.id);
          if (running) {
            if (queue.heartbeat(running.job, s.leaseMs)) continue;
            running.abort.abort();
            await running.promise;
          }
        }
        await pipeline.recoverExpired();
        nextRecovery = now + 1000;
      }
      queue.recheckMissing();
      if (now >= nextMetrics) {
        const memory = await (input.memory ?? availableMemoryMiB)();
        const disk = await (input.disk ?? (() => diskHeadroom(input.root)))();
        log({
          type: 'metrics',
          ...metrics(queue, started),
          availableMemoryMiB: Math.round(memory),
          diskHeadroomBytes: disk,
          rss: process.memoryUsage().rss,
          eventLoopP95Ms: Number.isFinite(eventLoop.mean)
            ? Math.round(eventLoop.percentile(95) / 1e6)
            : 0,
          admissionWaitingMs: Object.fromEntries(
            [...waiting].map(([reason, at]) => [reason, now - at]),
          ),
          runtime: input.runtimeMetrics?.(),
        });
        eventLoop.reset();
        nextMetrics = now + 30_000;
      }
      if (input.maintenance && !maintenance && now >= nextMaintenance) {
        maintenance = input
          .maintenance()
          .then(
            () => {},
            () => {
              queue.event('backup', 'failed', null);
            },
          )
          .finally(() => {
            maintenance = undefined;
          });
        nextMaintenance = now + 60_000;
      }
      if (
        input.inventory &&
        !inventory &&
        now >= nextInventory &&
        admissions &&
        // Once selection closes, drain this batch so the next one can admit ready work.
        selected.size < limit &&
        (limit === Infinity || input.inventoryDuringBoundedRun) &&
        queue.available('yutorah')
      ) {
        inventory = input
          .inventory()
          .then(
            () => {},
            (error) => {
              const e = classify(error, 'yutorah');
              queue.cooldown(
                'yutorah',
                e.retryAfterMs || 30_000,
                e.code,
                e.pause,
              );
              log({ stage: 'inventory', error: e.code });
            },
          )
          .finally(() => {
            inventory = undefined;
          });
        nextInventory = now + s.inventoryPaceMs;
      }
      if (admissions) {
        for (const stage of [
          'publishing',
          'generating',
          'fetching',
        ] as Stage[]) {
          const maximum =
            stage === 'fetching'
              ? s.fetchers
              : stage === 'generating'
                ? s.generators
                : s.publishers;
          while (counts[stage] < maximum) {
            let usage = queue.usage();
            let eligibilityOnly = false;
            if (stage === 'fetching') {
              if (Date.now() < nextFetch) break;
              const urgent = !!queue.db
                .prepare(
                  "SELECT 1 FROM jobs WHERE priority>=3 AND status='discovered' AND next_at<=? LIMIT 1",
                )
                .get(Date.now());
              // Make preparation room for requested repairs without discarding cached sources.
              while (
                urgent &&
                (usage.sourceCount >= s.readyMax ||
                  usage.sourceBytes + SOURCE_RESERVATION > s.sourceBytes)
              ) {
                if (!queue.deferNormalReady()) break;
                usage = queue.usage();
              }
              if (usage.sourceCount >= s.readyTarget) refilling = false;
              if (usage.sourceCount <= s.readyLow) refilling = true;
              const unknown = !!queue.db
                .prepare(
                  "SELECT 1 FROM jobs WHERE status='ready' AND eligibility='unknown' AND next_at<=? LIMIT 1",
                )
                .get(Date.now());
              if (
                !queue.available('yutorah') ||
                (!unknown &&
                  ((!refilling && !urgent) ||
                    usage.sourceCount >= s.readyMax ||
                    usage.sourceBytes + SOURCE_RESERVATION > s.sourceBytes))
              )
                break;
              eligibilityOnly =
                (!refilling && !urgent) ||
                usage.sourceCount >= s.readyMax ||
                usage.sourceBytes + SOURCE_RESERVATION > s.sourceBytes;
            }
            if (stage === 'generating') {
              // A crashed coordinator can leave a still-live request until its lease is reconciled.
              // Durable claims consume slots even before this process has started any workers.
              const occupied = Number(
                queue.db
                  .prepare(
                    "SELECT COUNT(*) AS count FROM jobs WHERE status='generating'",
                  )
                  .get()?.count ?? 0,
              );
              if (occupied >= s.generators) break;
              if (
                !queue.available('muse') ||
                !admission(
                  'outbox',
                  usage.outboxCount < s.outboxCount &&
                    usage.outboxBytes + OUTBOX_RESERVATION <= s.outboxBytes,
                ) ||
                !admission(
                  'quarantine',
                  usage.quarantineCount < s.quarantineCount &&
                    usage.quarantineBytes + OUTBOX_RESERVATION <=
                      s.quarantineBytes,
                )
              )
                break;
              if (
                !admission(
                  'memory',
                  (await (input.memory ?? availableMemoryMiB)()) >=
                    s.minFreeMemoryMiB + counts.generating * 512,
                )
              )
                break;
            }
            if (stage === 'publishing' && !queue.available('tidb')) break;
            if (
              stage !== 'publishing' &&
              !admission(
                stage + '_disk',
                (await (input.disk ?? (() => diskHeadroom(input.root)))()) >=
                  s.diskReserveBytes +
                    SOURCE_RESERVATION *
                      (1 + counts.generating + counts.fetching),
              )
            )
              break;
            const allowedIds =
              selected.size >= limit
                ? [...selected].filter((id) => !finished.has(id))
                : undefined;
            const job = queue.claim(stage, {
              leaseMs: s.leaseMs,
              backlog: sequence++ % 4 === 3,
              sourceReservation: stage === 'fetching' ? SOURCE_RESERVATION : 0,
              outboxReservation:
                stage === 'generating' ? OUTBOX_RESERVATION : 0,
              allowedIds,
              eligibilityOnly,
            });
            if (!job) break;
            if (stage === 'fetching') nextFetch = Date.now() + s.fetchSpacingMs;
            if (selected.size >= limit && !selected.has(job.id))
              throw new Error('Pilot reservation invariant violated.');
            launch(stage, job);
          }
        }
      }
      if (
        (!admissions || finished.size >= limit || !input.follow) &&
        active.size === 0 &&
        !inventory
      )
        break;
      if (active.size === 0 && !input.follow) break;
      await delay(100, undefined, { signal }).catch(() => {});
    }
    if (signal.aborted) for (const job of active.values()) job.abort.abort();
    await Promise.allSettled([...active.values()].map((v) => v.promise));
    await inventory;
    await maintenance;
  } finally {
    eventLoop.disable();
  }
  return {
    selected: selected.size,
    finished: finished.size,
    jobs: [...selected].map((id) =>
      queue.db
        .prepare(
          'SELECT id,status,source_hash,notes_hash,profile,route,artifact_path FROM jobs WHERE id=?',
        )
        .get(id),
    ),
    metrics: metrics(queue, started),
  };
}
