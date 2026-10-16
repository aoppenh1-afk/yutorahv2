import { BoundedCache } from './bounded-cache';
import type { SearchDatabase } from './search-storage';
import {
  SourcesLeaseError,
  validateSourceTranscript,
  type SourceTranscript,
} from './sources';
import {
  sourceText,
  sourceTextExcerpt,
  type SefariaFetch,
  type SourceText,
} from './sefaria';

const snapshots = new WeakMap<
  SearchDatabase,
  {
    cache: BoundedCache<SourceTranscript>;
    pending: Map<string, Promise<SourceTranscript>>;
  }
>();
const pruned = new WeakMap<SearchDatabase, number>();
const textLoads = new WeakMap<SefariaFetch, Map<string, Promise<SourceText>>>();

/** Neon limits the whole project, including template and maintenance databases.
 * Leave room for concurrent bounded requests and PostgreSQL index maintenance. */
export async function assertSourceStorageCapacity(db: SearchDatabase) {
  if (db.dialect !== 'postgres') return;
  const capacity = await db
    .prepare(`SELECT (SELECT sum(pg_database_size(oid)) FROM pg_database) AS bytes,
      pg_size_bytes(NULLIF(NULLIF(current_setting('neon.max_cluster_size',true),'-1'),'')) AS maximum`)
    .first<{ bytes: number | string; maximum: number | string | null }>();
  if (!capacity || !Number.isFinite(Number(capacity.bytes)))
    throw new Error('Source storage capacity could not be checked.');
  if (
    capacity.maximum !== null &&
    Number(capacity.maximum) > 0 &&
    Number(capacity.bytes) + 16 * 1024 * 1024 >= Number(capacity.maximum)
  )
    throw new SourcesLeaseError(
      'Source storage is near capacity. Retry after storage is expanded.',
    );
}

export async function pruneSourceCache(db: SearchDatabase) {
  const now = Date.now();
  if ((pruned.get(db) || 0) > now) return;
  await db
    .prepare(
      'DELETE FROM sources_runs WHERE id IN (SELECT id FROM sources_runs WHERE expires < ? AND lease < ? LIMIT 128)',
    )
    .bind(now, now)
    .run();
  await db
    .prepare(`DELETE FROM sources_runs WHERE id IN (
    SELECT id FROM (SELECT id,SUM(length(payload)*4) OVER(ORDER BY expires DESC,id) AS bytes,ROW_NUMBER() OVER(ORDER BY expires DESC,id) AS ordinal FROM sources_runs WHERE lease<? AND id NOT LIKE 'preparation:%' AND id NOT LIKE 'prepared:creator-v5:%' AND (id LIKE 'prepared:%' OR id LIKE 'text:%' OR payload LIKE '%"done":true%')) capacity WHERE bytes>33554432 OR ordinal>256 LIMIT 64
  )`)
    .bind(now)
    .run();
  await db
    .prepare(`DELETE FROM sources_runs WHERE id IN (
    SELECT id FROM sources_runs WHERE lease<? AND (
      id LIKE 'text:%' OR id LIKE 'creator-v4:%' OR id LIKE 'prepared:creator-v4:%' OR (payload LIKE '%"done":true%' AND (payload LIKE '%"occurrences"%' OR payload LIKE '%"mention"%'))
    ) LIMIT 128
  )`)
    .bind(now)
    .run();
  pruned.set(db, now + 60000);
}

/** Short published snapshots avoid repeated gateway reads; corrections are rechecked within one minute. */
export async function sourceSnapshot(
  db: SearchDatabase,
  id: string,
  load: () => Promise<SourceTranscript>,
  revision?: string | null,
  refresh = false,
): Promise<SourceTranscript> {
  let memory = snapshots.get(db);
  if (!memory) {
    memory = {
      cache: new BoundedCache(8, 8 * 1024 * 1024),
      pending: new Map(),
    };
    snapshots.set(db, memory);
  }
  const key = id + ':' + (revision || '');
  const previous = !refresh ? memory.cache.get(key) : undefined;
  if (previous) return previous;
  let pending = memory.pending.get(key);
  if (!pending) {
    if (memory.pending.size >= 16)
      throw new SourcesLeaseError('Sources are busy. Please retry.');
    const current = memory;
    pending = load()
      .then((transcript) => {
        validateSourceTranscript(transcript);
        current.cache.set(
          key,
          transcript,
          transcript.searchVersion ? 60 * 60_000 : 60000,
        );
        return transcript;
      })
      .finally(() => current.pending.delete(key));
    current.pending.set(key, pending);
  }
  return pending;
}

// Text stays in a bounded process cache. It is never written to SQL.
const textCaches = new WeakMap<SefariaFetch, BoundedCache<SourceText>>();
function textCache(fetcher: SefariaFetch) {
  let cache = textCaches.get(fetcher);
  if (!cache) {
    cache = new BoundedCache(32, 4 * 1024 * 1024);
    textCaches.set(fetcher, cache);
  }
  return cache;
}
export async function readCachedSourceText(
  _db: SearchDatabase | null,
  ref: string,
  extent: 'excerpt' | 'full' = 'excerpt',
  fetcher: SefariaFetch = fetch,
): Promise<SourceText | null> {
  const cache = textCache(fetcher);
  const cached = cache.get(`${extent}:${ref}`);
  if (cached) return cached;
  const full = extent === 'excerpt' ? cache.get(`full:${ref}`) : undefined;
  return full ? sourceTextExcerpt(full) : null;
}

/** Call only for a validated canonical reference. Errors never enter the cache. */
export async function cachedSourceText(
  db: SearchDatabase | null,
  ref: string,
  fetcher: SefariaFetch = fetch,
  extent: 'excerpt' | 'full' = 'excerpt',
): Promise<SourceText> {
  const cached = await readCachedSourceText(db, ref, extent, fetcher);
  if (cached) return cached;
  let pending = textLoads.get(fetcher);
  if (!pending) {
    pending = new Map();
    textLoads.set(fetcher, pending);
  }
  const full = extent === 'excerpt' ? pending.get(`full:${ref}`) : undefined;
  if (full) return sourceTextExcerpt(await full);
  const key = `${extent}:${ref}`;
  let work = pending.get(key);
  if (!work) {
    if (pending.size >= 16)
      throw new SourcesLeaseError('Source text is busy. Please retry.');
    const current = pending;
    work = sourceText(ref, fetcher, extent)
      .then((text) => {
        textCache(fetcher).set(key, text, 5 * 60000);
        return text;
      })
      .finally(() => current.delete(key));
    current.set(key, work);
  }
  return work;
}
