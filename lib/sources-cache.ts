import type { SearchDatabase } from './search-storage';
import {
  SourcesLeaseError,
  validateSourceTranscript,
  type SourceTranscript,
} from './sources';
import { sourceText, type SefariaFetch, type SourceText } from './sefaria';

type CacheRow = { payload: string; expires: number };
const snapshots = new WeakMap<
  SearchDatabase,
  Map<string, { expires: number; value: SourceTranscript }>
>();
const pruned = new WeakMap<SearchDatabase, number>();

export async function pruneSourceCache(db: SearchDatabase) {
  const now = Date.now();
  if ((pruned.get(db) || 0) > now) return;
  await db
    .prepare('DELETE FROM sources_runs WHERE expires < ? AND lease < ?')
    .bind(now, now)
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
    memory = new Map();
    snapshots.set(db, memory);
  }
  const previous = memory.get(id);
  if (
    !refresh &&
    previous &&
    previous.expires > Date.now() &&
    (!revision || previous.value.transcriptId === revision)
  )
    return previous.value;
  const key = `input:v1:${id}`;
  const row = refresh
    ? null
    : await db
        .prepare(
          'SELECT payload,expires FROM sources_runs WHERE id = ? AND expires > ?',
        )
        .bind(key, Date.now())
        .first<CacheRow>();
  let transcript = row ? (JSON.parse(row.payload) as SourceTranscript) : null;
  if (revision && transcript?.transcriptId !== revision) transcript = null;
  if (!transcript) {
    transcript = await load();
    validateSourceTranscript(transcript);
    const payload = JSON.stringify(transcript);
    if (new TextEncoder().encode(payload).length <= 900000)
      await db
        .prepare(
          'INSERT INTO sources_runs (id,payload,lease,expires) VALUES (?,?,0,?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, expires = excluded.expires',
        )
        .bind(key, payload, Date.now() + 60000)
        .run();
  }
  // At most eight immutable snapshots per warm server, independent of archive size.
  if (memory.size >= 8) memory.delete(memory.keys().next().value!);
  memory.set(id, {
    value: transcript,
    expires: row?.expires || Date.now() + 60000,
  });
  return transcript;
}

/** Only called after the handler verifies this exact canonical ref is cited. Errors never enter the cache. */
export async function cachedSourceText(
  db: SearchDatabase,
  ref: string,
  fetcher: SefariaFetch = fetch,
  extent: 'excerpt' | 'full' = 'excerpt',
): Promise<SourceText> {
  const key = `text:v2:${extent}:${ref}`;
  const now = Date.now();
  const row = await db
    .prepare(
      'SELECT payload,expires FROM sources_runs WHERE id = ? AND expires > ?',
    )
    .bind(key, now)
    .first<CacheRow>();
  if (row && row.payload !== '{}') return JSON.parse(row.payload) as SourceText;
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
