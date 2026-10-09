import {
  readTrendingIndex,
  selectTrendingChart,
  validTrendingIndex,
} from './trending-index';
import {
  TrendingChangedError,
  type DiscoveryData,
  type TrendingOptions,
} from './trending';
import type { SearchDatabase } from './search-storage';

const freshFor = (options: TrendingOptions) =>
  (options.period === 'all'
    ? 720
    : options.period === 'year'
      ? 360
      : options.period === 'month'
        ? 30
        : 5) *
  60 *
  1000;
const staleFor = 24 * 60 * 60 * 1000;
const savedChartFor = 7 * 24 * 60 * 60 * 1000;
const leaseFor = 60 * 1000;
const retryFor = 30 * 1000;
const progressFor = 3 * 1000;

export { TrendingChangedError } from './trending';

export class TrendingBusyError extends Error {}

/** Reserved run IDs cache bounded rankings and scan cursors.
 * No search_hits are created. Ordinary search fingerprints are SHA-256 digests,
 * so these records cannot be reused as metadata-search candidate sets.
 */
export function createTrendingService({
  database,
  read,
  now = Date.now,
  cacheKey,
  validate = () => true,
  preferCompleted = false,
  cachedOnly = false,
  requireStorage = false,
}: {
  database?: () => SearchDatabase;
  read?: (
    options: TrendingOptions,
    now: number,
    previous?: DiscoveryData,
  ) => Promise<DiscoveryData>;
  now?: () => number;
  /** Internal key for the shared library index. */
  cacheKey?: string;
  validate?: (data: DiscoveryData) => boolean;
  preferCompleted?: boolean;
  /** Read completed rankings without advancing an upstream scan. */
  cachedOnly?: boolean;
  /** Background jobs must not report success without saving their progress. */
  requireStorage?: boolean;
} = {}): (options: TrendingOptions) => Promise<DiscoveryData> {
  if (!read) {
    const shared = createTrendingService({
      database,
      now,
      read: readTrendingIndex,
      cacheKey: 'trending:v1:shared:2',
      validate: validTrendingIndex,
      preferCompleted: true,
      cachedOnly,
      requireStorage,
    });
    return async (options: TrendingOptions) =>
      selectTrendingChart(await shared({ period: 'all', minutes: 0 }), options);
  }
  const readSource = read;
  const retainedFor = cachedOnly ? savedChartFor : staleFor;
  const memory = new Map<string, DiscoveryData>();
  const completed = new Map<string, DiscoveryData>();
  const pending = new Map<string, Promise<DiscoveryData>>();
  const cooldowns = new Map<string, { until: number; error: unknown }>();
  const age = (data: DiscoveryData) => now() - Date.parse(data.fetchedAt);
  const usable = (data: DiscoveryData | undefined, ttl: number) =>
    !!data && age(data) >= 0 && age(data) < ttl;

  const present = (key: string, data: DiscoveryData) => {
    const complete = completed.get(key);
    return preferCompleted && data.partial && usable(complete, retainedFor)
      ? { ...complete!, refreshing: true, stale: data.stale }
      : data;
  };

  const fallback = (key: string, previous?: DiscoveryData) => {
    const complete = completed.get(key);
    return usable(complete, retainedFor)
      ? complete
      : (!cachedOnly || !previous?.partial) && usable(previous, retainedFor)
        ? previous
        : undefined;
  };

  async function refresh(key: string, options: TrendingOptions) {
    let previous = memory.get(key);
    let db: SearchDatabase | undefined;
    let lease = 0;
    let releaseLease = true;
    try {
      db = database?.();
      if (requireStorage && !db)
        throw new Error('Trending refresh requires persistent storage.');
      if (db) {
        const row = await db
          .prepare(
            'SELECT plan FROM search_runs WHERE id = ? AND fingerprint = ?',
          )
          .bind(key, key)
          .first<{ plan: string }>();
        if (row) {
          let valid = false;
          try {
            const parsed = JSON.parse(row.plan) as {
              snapshot?: DiscoveryData;
              lastComplete?: DiscoveryData;
            };
            const last = parsed.lastComplete;
            if (
              last &&
              validate(last) &&
              !last.partial &&
              last.period === options.period &&
              last.minutes === options.minutes &&
              last.dateBasis === 'upload-date' &&
              Array.isArray(last.trending) &&
              last.trending.length <= 30 &&
              Number.isSafeInteger(last.total) &&
              last.sampled === (last.libraryTotal ?? last.total) &&
              last.total >= last.trending.length &&
              Number.isFinite(Date.parse(last.fetchedAt))
            )
              completed.set(key, last);
            const snapshot = parsed.snapshot;
            if (
              snapshot &&
              validate(snapshot) &&
              snapshot.period === options.period &&
              snapshot.minutes === options.minutes &&
              snapshot.dateBasis === 'upload-date' &&
              Array.isArray(snapshot.trending) &&
              Number.isSafeInteger(snapshot.total) &&
              snapshot.total >= snapshot.trending.length &&
              Number.isSafeInteger(snapshot.sampled) &&
              snapshot.sampled >= snapshot.trending.length &&
              snapshot.sampled <= (snapshot.libraryTotal ?? snapshot.total) &&
              snapshot.partial ===
                snapshot.sampled < (snapshot.libraryTotal ?? snapshot.total) &&
              (!snapshot.partial ||
                (snapshot.source === 'mobile'
                  ? Number.isSafeInteger(snapshot.nextPage) &&
                    snapshot.nextPage! > 0 &&
                    typeof snapshot.seen === 'string' &&
                    snapshot.seen.length <= 1400000 &&
                    Number.isSafeInteger(snapshot.libraryTotal)
                  : Number.isSafeInteger(snapshot.nextId) &&
                    snapshot.nextId! > 0)) &&
              snapshot.trending.length <= 30 &&
              Number.isFinite(Date.parse(snapshot.fetchedAt)) &&
              (!previous ||
                Date.parse(snapshot.fetchedAt) > Date.parse(previous.fetchedAt))
            ) {
              previous = snapshot;
              if (!snapshot.partial) completed.set(key, snapshot);
              valid = true;
            }
          } catch {
            /* Discard corrupt cache entries; rebuild from the source. */
          }
          if (!cachedOnly && !valid && !usable(previous, staleFor))
            await db
              .prepare(
                'UPDATE search_runs SET created = 0 WHERE id = ? AND plan = ? AND lease <= ?',
              )
              .bind(key, row.plan, now())
              .run();
        }
        if (previous) memory.set(key, previous);
        if (cachedOnly) {
          const saved = fallback(key, previous);
          if (!saved)
            throw new TrendingBusyError(
              'This chart is being prepared in the background. Please try again shortly.',
            );
          return {
            ...saved,
            stale: !usable(saved, freshFor(options)),
            refreshing: previous?.partial || undefined,
          };
        }
        if (
          usable(previous, previous?.partial ? progressFor : freshFor(options))
        ) {
          memory.set(key, previous!);
          return previous!;
        }
        await db
          .prepare(
            'INSERT OR IGNORE INTO search_runs (id,fingerprint,plan,total,next,created,lease) VALUES (?,?,?,0,1,0,0)',
          )
          .bind(key, key, '{}')
          .run();
        const started = now();
        lease = started + leaseFor;
        const claimed = await db
          .prepare(
            'UPDATE search_runs SET lease = ? WHERE id = ? AND lease <= ? AND created <= ?',
          )
          .bind(
            lease,
            key,
            started,
            started - (previous?.partial ? progressFor : freshFor(options)),
          )
          .run();
        if (!claimed.meta.changes) {
          const cached = fallback(key, previous);
          if (cached) return { ...cached, stale: true };
          throw new TrendingBusyError(
            'This chart is refreshing. Please try again shortly.',
          );
        }
      }
    } catch (error) {
      if (error instanceof TrendingBusyError) throw error;
      if (cachedOnly) {
        const saved = fallback(key, previous);
        if (saved) return { ...saved, stale: true };
        throw new TrendingBusyError('Saved trending charts are unavailable.');
      }
      if (requireStorage) throw error;
      // Caching is optional during local setup or a storage outage.
      db = undefined;
    }
    if (cachedOnly)
      throw new TrendingBusyError('Saved trending storage is unavailable.');
    try {
      const data = await readSource(
        options,
        now(),
        usable(previous, staleFor) ? previous : undefined,
      );
      if (data.partial && previous && !previous.partial)
        completed.set(key, previous);
      if (db) {
        try {
          const saved = await db
            .prepare(
              'UPDATE search_runs SET plan = ?, total = ?, next = ?, created = ?, lease = 0 WHERE id = ? AND lease = ?',
            )
            .bind(
              JSON.stringify({
                kind: 'trending',
                options,
                snapshot: data,
                lastComplete: data.partial ? completed.get(key) : undefined,
              }),
              data.libraryTotal ?? data.total,
              Math.ceil(data.sampled / 30) + 1,
              Date.parse(data.fetchedAt),
              key,
              lease,
            )
            .run();
          if (requireStorage && !saved.meta.changes)
            throw new TrendingBusyError(
              'The trending scan lease expired before progress was saved.',
            );
        } catch (error) {
          if (requireStorage) throw error;
          /* A successful upstream response survives cache write failure. */
        }
      }
      memory.set(key, data);
      if (!data.partial) completed.set(key, data);
      return data;
    } catch (error) {
      if (error instanceof TrendingChangedError) {
        memory.delete(key);
        if (db) {
          try {
            await db
              .prepare(
                'UPDATE search_runs SET plan = ?, created = 0, lease = 0 WHERE id = ? AND lease = ?',
              )
              .bind(
                JSON.stringify({ lastComplete: completed.get(key) }),
                key,
                lease,
              )
              .run();
          } catch {
            /* Retry from a fresh cohort when storage recovers. */
          }
        }
        throw error;
      }
      releaseLease = false;
      const cached = fallback(key, previous);
      if (cached) {
        if (previous) memory.set(key, previous);
        return { ...cached, stale: true };
      }
      throw error;
    } finally {
      if (db && releaseLease) {
        try {
          await db
            .prepare(
              'UPDATE search_runs SET lease = 0 WHERE id = ? AND lease = ?',
            )
            .bind(key, lease)
            .run();
        } catch {
          /* An abandoned lease expires after sixty seconds. */
        }
      }
    }
  }

  return async (options: TrendingOptions) => {
    const key = cacheKey ?? `trending:v1:${options.period}:${options.minutes}`;
    const hit = memory.get(key);
    if (
      !cachedOnly &&
      usable(hit, hit?.partial ? progressFor : freshFor(options))
    )
      return present(key, hit!);
    const cooldown = cooldowns.get(key);
    if (cooldown && cooldown.until > now()) {
      const cached = fallback(key, hit);
      if (cached) return present(key, { ...cached, stale: true });
      throw cooldown.error;
    }
    const existing = pending.get(key);
    if (existing) return present(key, await existing);
    const request = refresh(key, options);
    pending.set(key, request);
    try {
      const data = await request;
      if (data.stale) {
        cooldowns.set(key, {
          until: now() + retryFor,
          error: new TrendingBusyError('This chart is refreshing.'),
        });
      } else cooldowns.delete(key);
      return present(key, data);
    } catch (error) {
      cooldowns.set(key, { until: now() + retryFor, error });
      throw error;
    } finally {
      pending.delete(key);
    }
  };
}
