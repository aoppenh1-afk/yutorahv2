import type { SearchDatabase, SearchStatement } from './search-storage';
import { searchText, wordMatch } from './search-matching';

type TitleRecord = { id: number; title: string };
type TitleTerm = { term: string; words: number; documents: number };

/** Short deletion keys find candidates without reading the archive dictionary.
 * The shared matcher still validates the entire word, including its suffix.
 */
function spellingKeys(word: string): string[] {
  const prefix = Array.from(word).slice(0, 7).join('');
  const keys = new Set([prefix]);
  let previous = [prefix];
  for (let edit = 0; edit < (word.length >= 7 ? 2 : 1); edit++) {
    const next = new Set<string>();
    for (const value of previous) {
      const letters = Array.from(value);
      for (let i = 0; i < letters.length; i++)
        next.add(letters.filter((_, j) => i !== j).join(''));
    }
    for (const value of next) keys.add(value);
    previous = [...next];
  }
  return [...keys].map((key) => `d:${key}`);
}

function termKeys(term: string, words: number): string[] {
  return [
    `j:${term.replaceAll(' ', '')}`,
    ...(words === 1 ? [`p:${term.slice(0, 3)}`, ...spellingKeys(term)] : []),
  ];
}

export function titleTerms(title: string): string[] {
  const words = searchText(title).split(' ').filter(Boolean).slice(0, 80);
  const terms = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let count = 1; count <= 3 && i + count <= words.length; count++) {
      const span = words.slice(i, i + count);
      const term = span.join(' ');
      if (
        term.length >= (count === 1 ? 3 : 5) &&
        term.length <= 64 &&
        span.every((word) => /^[\p{L}]+$/u.test(word))
      )
        terms.add(term);
    }
  }
  return [...terms];
}

/** Compose with the search pass transaction: titles survive query-cache expiry.
 * Triggers count each title once and replace its old vocabulary on title edits.
 */
export function indexTitleStatements(
  db: SearchDatabase,
  records: TitleRecord[],
  includeSpellingKeys = true,
): SearchStatement[] {
  const titles = [
    ...new Map(records.map((record) => [record.id, record])).values(),
  ]
    .filter((record) => Number.isSafeInteger(record.id) && record.id > 0)
    .map((record) => ({ ...record, terms: titleTerms(record.title) }));
  const keys = new Map<string, [string, string]>();
  for (const { terms } of includeSpellingKeys ? titles : [])
    for (const term of terms)
      for (const key of termKeys(term, term.split(' ').length))
        keys.set(`${key}\0${term}`, [key, term]);
  const statements: SearchStatement[] = [];
  // Keep both SQL parameter counts and the number of D1 queries bounded.
  for (
    let i = 0;
    i < titles.length;
    i += db.dialect === 'postgres' ? 500 : 30
  ) {
    const group = titles.slice(i, i + (db.dialect === 'postgres' ? 500 : 30));
    statements.push(
      db
        .prepare(
          `INSERT INTO search_title_catalog (id,title,terms) VALUES ${group.map(() => '(?,?,?)').join(',')}
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, terms=excluded.terms
         WHERE search_title_catalog.title != excluded.title`,
        )
        .bind(
          ...group.flatMap((record) => [
            record.id,
            record.title,
            JSON.stringify(record.terms),
          ]),
        ),
    );
  }
  const entries = [...keys.values()];
  for (let i = 0; i < entries.length; i += 2000) {
    const group = entries.slice(i, i + 2000);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO search_title_keys (key,term)
         SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)`,
        )
        .bind(JSON.stringify(group)),
    );
  }
  return statements;
}

/** Avoid tokenization and spelling-key writes for previously learned titles. */
export async function changedTitleStatements(
  db: SearchDatabase,
  records: TitleRecord[],
) {
  const unique = [
    ...new Map(records.map((record) => [record.id, record])).values(),
  ];
  const known = new Map<number, string>();
  for (let i = 0; i < unique.length; i += 90) {
    const ids = unique.slice(i, i + 90).map((record) => record.id);
    if (!ids.length) continue;
    const { results } = await db
      .prepare(
        `SELECT id,title FROM search_title_catalog WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .bind(...ids)
      .all<TitleRecord>();
    for (const record of results) known.set(record.id, record.title);
  }
  return indexTitleStatements(
    db,
    unique.filter((record) => known.get(record.id) !== record.title),
  );
}

/** Exact archive spellings protect words before request interpretation. */
export async function knownTitleWords(
  db: SearchDatabase,
  query: string,
): Promise<string[]> {
  const words = [
    ...new Set(searchText(query).split(' ').filter(Boolean)),
  ].slice(0, 32);
  if (!words.length) return [];
  const { results } = await db
    .prepare(
      `SELECT term FROM search_title_terms WHERE words=1 AND documents>0 AND term IN (${words.map(() => '?').join(',')})`,
    )
    .bind(...words)
    .all<{ term: string }>();
  return results.map((row) => row.term);
}

/** Look up only candidates for this request; never load all titles into memory.
 * Quoted spans and numbers remain literal. Actual title frequency breaks ties.
 */
export async function titleVocabulary(db: SearchDatabase, query: string) {
  const tokens = [...query.matchAll(/"[^"]*"|[\p{L}\p{M}\p{N}'’״׳]+/gu)]
    .map((token) => (token[0].startsWith('"') ? '' : searchText(token[0])))
    .slice(0, 32);
  const requested: { key: string; slot: number }[] = [];
  for (const [slot, word] of tokens.entries()) {
    if (!word || /\p{N}/u.test(word)) continue;
    if (word.length >= 3 && word.length <= 64)
      for (const key of [`p:${word.slice(0, 3)}`, ...spellingKeys(word)])
        requested.push({ key, slot });
    for (let count = 1; count <= 3; count++) {
      const span = tokens.slice(slot, slot + count);
      if (
        span.length !== count ||
        span.some((part) => !part || /\p{N}/u.test(part))
      )
        break;
      const compact = span.join('');
      if (compact.length >= 5 && compact.length <= 64)
        requested.push({ key: `j:${compact}`, slot: -1 });
    }
  }
  if (!requested.length)
    return { words: [] as string[], phrases: [] as string[] };
  const { results } = await db
    .prepare(
      `WITH requested AS (
       SELECT DISTINCT json_extract(value,'$.key') AS key, json_extract(value,'$.slot') AS slot FROM json_each(?)
     ), candidates AS (
       SELECT r.slot,t.term,t.words,t.documents,COUNT(*) AS overlap
       FROM requested r JOIN search_title_keys k ON k.key=r.key
       JOIN search_title_terms t ON t.term=k.term WHERE t.documents > 0
       GROUP BY r.slot,t.term
     ), ranked AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY slot ORDER BY overlap DESC,documents DESC,term) AS position FROM candidates
     ) SELECT term,words,documents FROM ranked WHERE slot=-1 OR position <= 64`,
    )
    .bind(JSON.stringify(requested))
    .all<TitleTerm>();
  const unique = [
    ...new Map(results.map((record) => [record.term, record])).values(),
  ];
  const words = unique
    .filter((record) => record.words === 1)
    .map((record) => ({
      ...record,
      score: Math.max(
        ...tokens.filter(Boolean).map((word) => wordMatch(word, record.term)),
      ),
    }))
    .filter((record) => record.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.documents - a.documents ||
        a.term.localeCompare(b.term),
    )
    .map((record) => record.term);
  return { words, phrases: unique.map((record) => record.term) };
}

/** Seed a pre-existing cache in bounded passes without losing it on expiry. */
export async function seedCachedTitles(db: SearchDatabase) {
  const { results } = await db
    .prepare(
      `SELECT h.id,MAX(json_extract(COALESCE(d.payload,h.payload),'$.title')) AS title FROM search_hits h LEFT JOIN search_documents d ON d.key=h.document_key
     LEFT JOIN search_title_catalog t ON t.id=h.id WHERE t.id IS NULL
     GROUP BY h.id LIMIT 120`,
    )
    .all<TitleRecord>();
  if (results.length) await db.batch(indexTitleStatements(db, results));
  return results.length;
}
