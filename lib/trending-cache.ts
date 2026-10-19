import { gzipSync, gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
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
import { performanceSample } from './performance-metrics';

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
const leaseFor = 75 * 1000;
const retryFor = 30 * 1000;
const progressFor = 3 * 1000;
const savedReadFor = 60 * 1000;
const packedPrefix = 'gzip:v1:';
const maxPlanBytes = 16 * 1024 * 1024;

type StoredTrendingPlan = {
  kind?: string;
  options?: TrendingOptions;
  snapshot?: DiscoveryData;
  lastComplete?: DiscoveryData;
};

/** Keep the original JSON for older deployments and add a compressed read
 * representation. SQL selects only that representation for scan resumptions. */
export function serializeTrendingPlan(plan: StoredTrendingPlan) {
  const text = JSON.stringify(plan);
  const raw = Buffer.from(text);
  if (raw.length < 32_000 || raw.length > maxPlanBytes) return text;
  const compressedPlan = packedPrefix + gzipSync(raw).toString('base64');
  const display = (data?: DiscoveryData) =>
    data && {
      ...data,
      seen: undefined,
      index: data.index && { ...data.index, audit: undefined },
    };
  const publicText = JSON.stringify({
    ...plan,
    snapshot: display(plan.snapshot),
    lastComplete: display(plan.lastComplete),
  });
  const packedPublic = packedPrefix + gzipSync(publicText).toString('base64');
  const compressedPublicPlan =
    packedPublic.length < Buffer.byteLength(publicText)
      ? packedPublic
      : undefined;
  return compressedPlan.length < raw.length
    ? JSON.stringify({ ...plan, compressedPlan, compressedPublicPlan })
    : text;
}

function parseTrendingPlan(plan: string): StoredTrendingPlan {
  if (!plan.startsWith(packedPrefix)) return JSON.parse(plan);
  const encoded = plan.slice(packedPrefix.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded)
    throw new Error('Invalid compressed trending state.');
  return JSON.parse(
    gunzipSync(bytes, { maxOutputLength: maxPlanBytes }).toString('utf8'),
  );
}

const storedPlanField = (db: SearchDatabase) =>
  db.dialect === 'postgres'
    ? "CASE WHEN plan IS JSON OBJECT THEN COALESCE(plan::jsonb->>'compressedPlan',plan) ELSE plan END"
    : "CASE WHEN json_valid(plan) THEN COALESCE(json_extract(plan,'$.compressedPlan'),plan) ELSE plan END";

/** Public readers need rankings and coverage summaries, never scan bitmaps or
 * the independent census. Remove those inside SQL before they leave storage. */
export function trendingPlanSql(db: SearchDatabase, publicOnly: boolean) {
  const paths = [
    ['compressedPlan'],
    ['compressedPublicPlan'],
    ['snapshot', 'seen'],
    ['snapshot', 'index', 'audit'],
    ['lastComplete', 'seen'],
    ['lastComplete', 'index', 'audit'],
  ];
  const plan = !publicOnly
    ? storedPlanField(db)
    : db.dialect === 'postgres'
      ? `CASE WHEN plan IS JSON OBJECT THEN COALESCE(plan::jsonb->>'compressedPublicPlan',(plan::jsonb ${paths.map((path) => `#- '{${path.join(',')}}'`).join(' ')})::text) ELSE plan END`
      : `CASE WHEN json_valid(plan) THEN COALESCE(json_extract(plan,'$.compressedPublicPlan'),json_remove(plan,${paths.map((path) => `'$.${path.join('.')}'`).join(',')})) ELSE plan END`;
  return `SELECT ${plan} AS plan FROM search_runs WHERE id = ? AND fingerprint = ?`;
}

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
  reportProgress = false,
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
  /** Read saved rankings without advancing an upstream scan. */
  cachedOnly?: boolean;
  /** Background jobs must not report success without saving their progress. */
  requireStorage?: boolean;
  /** Protected runners need the active checkpoint, even while old charts are served. */
  reportProgress?: boolean;
} = {}): (options: TrendingOptions) => Promise<DiscoveryData> {
  if (!read) {
    const shared = createTrendingService({
      database,
      now,
      read: readTrendingIndex,
      cacheKey: 'trending:v1:shared:2',
      // A display snapshot has no checkpoint bytes. Resuming a scan always
      // retains the full validator and original persisted state.
      validate: (data) => validTrendingIndex(data, !cachedOnly),
      preferCompleted: !reportProgress,
      cachedOnly,
      requireStorage,
      reportProgress,
    });
    return async (options: TrendingOptions) =>
      selectTrendingChart(await shared({ period: 'all', minutes: 0 }), options);
  }
  const readSource = read;
  // A source outage does not make a valid saved chart disappear. Its original
  // timestamp and partial coverage tell clients how current it is.
  const retainedFor = cachedOnly ? Infinity : staleFor;
  const memory = new Map<string, DiscoveryData>();
  const completed = new Map<string, DiscoveryData>();
  const pending = new Map<string, Promise<DiscoveryData>>();
  const cooldowns = new Map<string, { until: number; error: unknown }>();
  const savedReads = new Map<
    string,
    { data: DiscoveryData; expires: number }
  >();
  const age = (data: DiscoveryData) => now() - Date.parse(data.fetchedAt);
  // Old completed unions can still be shown, but cannot suppress the first
  // independent census after deployment. Keep the same persisted cache row.
  const unaudited = (data?: DiscoveryData) =>
    !!data?.index && !data.partial && !data.coverage;
  const usable = (data: DiscoveryData | undefined, ttl: number) =>
    !!data && age(data) >= 0 && age(data) < ttl;

  const present = (key: string, data: DiscoveryData) => {
    const complete = completed.get(key);
    return preferCompleted && data.partial && usable(complete, retainedFor)
      ? {
          ...complete!,
          refreshing: true,
          stale: data.stale,
          coverage: data.coverage,
        }
      : data;
  };

  const fallback = (key: string, previous?: DiscoveryData) => {
    const complete = completed.get(key);
    return usable(complete, retainedFor)
      ? complete
      : usable(previous, retainedFor)
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
          .prepare(trendingPlanSql(db, cachedOnly))
          .bind(key, key)
          .first<{ plan: string }>();
        if (row) {
          performanceSample('trending_snapshot', {
            public: cachedOnly ? 1 : 0,
            bytes: new TextEncoder().encode(row.plan).length,
            hit: 0,
          });
          let valid = false;
          try {
            const parsed = parseTrendingPlan(row.plan);
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
              (snapshot.coverage ||
                (snapshot.sampled <=
                  (snapshot.libraryTotal ?? snapshot.total) &&
                  snapshot.partial ===
                    snapshot.sampled <
                      (snapshot.libraryTotal ?? snapshot.total))) &&
              (!snapshot.partial ||
                (snapshot.source === 'mobile'
                  ? Number.isSafeInteger(snapshot.nextPage) &&
                    snapshot.nextPage! > 0 &&
                    (cachedOnly ||
                      (typeof snapshot.seen === 'string' &&
                        snapshot.seen.length <= 1400000)) &&
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
                `UPDATE search_runs SET created = 0 WHERE id = ? AND ${storedPlanField(db)} = ? AND lease <= ?`,
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
            stale: saved.partial || !usable(saved, freshFor(options)),
            refreshing: (!saved.partial && previous?.partial) || undefined,
            coverage: previous?.partial ? previous.coverage : saved.coverage,
          };
        }
        if (
          previous?.partial &&
          previous.coverage?.retryAt &&
          previous.coverage.retryAt > now()
        )
          return previous;
        if (
          !unaudited(previous) &&
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
            started -
              (previous?.partial
                ? progressFor
                : unaudited(previous)
                  ? 0
                  : freshFor(options)),
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
        // Resume valid persisted coverage even after a prolonged outage.
        usable(previous, previous?.partial ? Infinity : staleFor)
          ? previous
          : undefined,
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
              serializeTrendingPlan({
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
          if (!saved.meta.changes)
            throw new TrendingBusyError(
              'The trending scan lease expired before progress was saved.',
            );
          releaseLease = false;
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
                serializeTrendingPlan({ lastComplete: completed.get(key) }),
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
      const cached = reportProgress ? previous : fallback(key, previous);
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
    const saved = cachedOnly && savedReads.get(key);
    if (saved && saved.expires > now()) {
      performanceSample('trending_snapshot', { public: 1, hit: 1, bytes: 0 });
      return {
        ...saved.data,
        stale:
          saved.data.stale ||
          saved.data.partial ||
          !usable(saved.data, freshFor(options)),
      };
    }
    savedReads.delete(key);
    const hit = memory.get(key);
    if (
      !cachedOnly &&
      !unaudited(hit) &&
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
      if (cachedOnly)
        savedReads.set(key, {
          data,
          expires:
            now() +
            (data.partial || data.refreshing
              ? progressFor
              : data.stale
                ? retryFor
                : savedReadFor),
        });
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
