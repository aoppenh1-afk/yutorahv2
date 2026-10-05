import { normalizeTranscriptSearch } from '../../yutorah-core/src/search.js';
import type { ArchiveDatabase } from './archive.js';
import type { PublicContent } from './public-content.js';

export function spellingKeys(word: string) {
  const prefix = Array.from(word).slice(0, 7);
  const keys = new Set([prefix.join('')]);
  for (let i = 0; i < prefix.length; i++)
    keys.add(prefix.filter((_, j) => j !== i).join(''));
  return [...keys].map((k) => `d:${k}`);
}

/** Small deterministic buckets keep each JSON lookup bounded in D1. */
export function spellingBucket(key: string) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++)
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) % 1024;
}

export type SpellingBase = Array<{ bucket: number; body: string }>;
export function buildSpellingBase(
  contents: Iterable<PublicContent>,
): SpellingBase {
  const words = new Set<string>();
  for (const c of contents)
    for (const s of c.segments)
      for (const word of normalizeTranscriptSearch(s.text).split(' '))
        if (word.length >= 3 && word.length <= 64) words.add(word);
  const buckets = new Map<number, Record<string, string[]>>();
  for (const word of [...words].sort())
    for (const key of spellingKeys(word)) {
      const bucket = spellingBucket(key);
      const entries: Record<string, string[]> = buckets.get(bucket) ?? {};
      buckets.set(bucket, entries);
      (entries[key] ??= []).push(word);
    }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([bucket, entries]) => {
      const body = JSON.stringify(entries);
      if (new TextEncoder().encode(body).length > 1_500_000)
        throw new Error(
          'Spelling bucket exceeds the Free database row budget.',
        );
      return { bucket, body };
    });
}

export async function verifySpellingBase(
  db: ArchiveDatabase,
  base: SpellingBase,
) {
  for (let i = 0; i < base.length; i += 20) {
    const group = base.slice(i, i + 20);
    const rows = await db
      .prepare(
        `SELECT bucket,body FROM archive_spelling_base WHERE bucket IN (${group.map(() => '?').join(',')})`,
      )
      .bind(...group.map((b) => b.bucket))
      .all<{ bucket: number; body: string }>();
    const expected = new Map(group.map((b) => [b.bucket, b.body]));
    if (
      rows.results.length !== group.length ||
      rows.results.some((r) => expected.get(r.bucket) !== r.body)
    )
      throw new Error('Spelling base verification failed.');
  }
}

export async function seedSpellingBase(
  db: ArchiveDatabase,
  base: SpellingBase,
) {
  for (let i = 0; i < base.length; i += 20)
    await db.batch(
      base
        .slice(i, i + 20)
        .map(({ bucket, body }) =>
          db
            .prepare(
              'INSERT INTO archive_spelling_base(bucket,body) VALUES(?,?) ON CONFLICT(bucket) DO UPDATE SET body=excluded.body WHERE body<>excluded.body',
            )
            .bind(bucket, body),
        ),
    );
  await verifySpellingBase(db, base);
}
