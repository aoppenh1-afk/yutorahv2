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

type CacheRow = { payload: string; expires: number };
const snapshots = new WeakMap<
  SearchDatabase,
  {
    cache: BoundedCache<SourceTranscript>;
    pending: Map<string, Promise<SourceTranscript>>;
  }
>();
const pruned = new WeakMap<SearchDatabase, number>();
const textLoads = new WeakMap<
  SearchDatabase,
  Map<string, Promise<SourceText>>
>();

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
    SELECT id FROM (SELECT id,SUM(length(payload)*4) OVER(ORDER BY expires DESC,id) AS bytes,ROW_NUMBER() OVER(ORDER BY expires DESC,id) AS ordinal FROM sources_runs WHERE lease<? AND id NOT LIKE 'prepared:%' AND id NOT LIKE 'preparation:%' AND (id LIKE 'text:%' OR payload LIKE '%"done":true%')) capacity WHERE bytes>33554432 OR ordinal>256 LIMIT 64
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

/** Every saved text was fetched for this exact ref; a warm hit needs no upstream validation. */
export async function readCachedSourceText(
  db: SearchDatabase,
  ref: string,
  extent: 'excerpt' | 'full' = 'excerpt',
): Promise<SourceText | null> {
  const key = `text:v2:${extent}:${ref}`;
  const now = Date.now();
  const row = await db
    .prepare(
      'SELECT payload,expires FROM sources_runs WHERE id = ? AND expires > ?',
    )
    .bind(key, now)
    .first<CacheRow>();
  const decode = (row: CacheRow | null) => {
    if (!row || row.payload === '{}') return null;
    try {
      const text = JSON.parse(row.payload) as SourceText;
      return text?.ref === ref && Array.isArray(text.editions) ? text : null;
    } catch {
      return null;
    }
  };
  const cached = decode(row);
  if (cached) return cached;
  if (extent === 'excerpt') {
    const full = await db
      .prepare(
        'SELECT payload,expires FROM sources_runs WHERE id = ? AND expires > ?',
      )
      .bind(`text:v2:full:${ref}`, now)
      .first<CacheRow>();
    const text = decode(full);
    if (text) return sourceTextExcerpt(text);
  }
  return null;
}

/** Call only for a validated canonical reference. Errors never enter the cache. */
export async function cachedSourceText(
  db: SearchDatabase,
  ref: string,
  fetcher: SefariaFetch = fetch,
  extent: 'excerpt' | 'full' = 'excerpt',
): Promise<SourceText> {
  let pending = textLoads.get(db);
  if (!pending) {
    pending = new Map();
    textLoads.set(db, pending);
  }
  const full = extent === 'excerpt' ? pending.get(`full:${ref}`) : undefined;
  if (full) return sourceTextExcerpt(await full);
  const key = `${extent}:${ref}`;
  let work = pending.get(key);
  if (!work) {
    if (pending.size >= 16)
      throw new SourcesLeaseError('Source text is busy. Please retry.');
    const current = pending;
    work = loadSourceText(db, ref, fetcher, extent).finally(() =>
      current.delete(key),
    );
    pending.set(key, work);
  }
  return work;
}

async function loadSourceText(
  db: SearchDatabase,
  ref: string,
  fetcher: SefariaFetch,
  extent: 'excerpt' | 'full',
): Promise<SourceText> {
  const cached = await readCachedSourceText(db, ref, extent);
  if (cached) return cached;
  const key = `text:v2:${extent}:${ref}`;
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO sources_runs (id,payload,lease,expires) VALUES (?, ?, 0, ?) ON CONFLICT(id) DO NOTHING',
    )
    .bind(key, '{}', now + 86400000)
    .run();
  const lease = now + 60000;
  const claim = await db
    .prepare('UPDATE sources_runs SET lease = ? WHERE id = ? AND lease < ?')
    .bind(lease, key, now)
    .run();
  if (!claim.meta.changes)
    throw new SourcesLeaseError('Source text is being checked.');
  try {
    const text = await sourceText(ref, fetcher, extent);
    const payload = JSON.stringify(text);
    if (new TextEncoder().encode(payload).length > 900000)
      throw new Error('This source text is too large to cache.');
    const saved = await db
      .prepare(
        'UPDATE sources_runs SET payload = ?, expires = ? WHERE id = ? AND lease = ? AND lease > ?',
      )
      .bind(payload, Date.now() + 86400000, key, lease, Date.now())
      .run();
    if (!saved.meta.changes)
      throw new SourcesLeaseError('Source text processing ownership changed.');
    return text;
  } finally {
    await db
      .prepare('UPDATE sources_runs SET lease = 0 WHERE id = ? AND lease = ?')
      .bind(key, lease)
      .run();
  }
}
