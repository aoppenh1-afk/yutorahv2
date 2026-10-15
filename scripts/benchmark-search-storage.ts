import { Pool } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { postgresSearchDatabase } from '../lib/search-postgres';
import { indexTitleStatements } from '../lib/title-index';
import { compactSearchTitleBatch } from '../lib/search-compaction';

if (!process.env.TEST_DATABASE_URL)
  throw new Error('Use a disposable TEST_DATABASE_URL.');
const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? '' : (args[index + 1] ?? '');
};
const count = Number(value('--rows') || 20000);
if (!Number.isSafeInteger(count) || count < 100 || count > 500000)
  throw new Error('Choose 100–500000 synthetic titles.');
const schema = 'storage_bench_' + randomUUID().replaceAll('-', '');
const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 2,
});
const client = await pool.connect();
const migration = (file: string) =>
  readFileSync('db/search-postgres/' + file, 'utf8').replace(
    /\byutorah_search\b/g,
    schema,
  );
try {
  for (const file of [
    '001_search.sql',
    '002_sources.sql',
    '003_efficiency.sql',
    '004_fencing.sql',
  ])
    await client.query(migration(file));
  const db = postgresSearchDatabase(pool, schema);
  const letters = (i: number) => {
    let word = '';
    for (let j = 0; j < 5; j++) {
      word = String.fromCharCode(97 + (i % 26)) + word;
      i = Math.floor(i / 26);
    }
    return word;
  };
  for (let start = 0; start < count; start += 500) {
    await db.batch(
      indexTitleStatements(
        db,
        Array.from({ length: Math.min(500, count - start) }, (_, offset) => {
          const i = start + offset;
          return {
            id: i + 1,
            title: `${i % 2 ? 'Practical Hilchos Shabbos' : 'עיונים בהלכות שבת'} vocabulary${letters(i)} Chapter ${letters(i % 300)}`,
          };
        }),
        false,
      ),
    );
  }
  const measure = async () =>
    (
      await client.query(`SELECT
    pg_total_relation_size('${schema}.search_title_catalog')::int AS catalog_bytes,
    pg_total_relation_size('${schema}.search_title_terms')::int AS vocabulary_bytes,
    (SELECT count(*)::int FROM ${schema}.search_title_terms) AS vocabulary_rows`)
    ).rows[0];
  const digest = async (catalog: boolean, compact = false) => {
    const hash = createHash('sha256');
    let cursor: string | number = catalog ? 0 : '';
    for (;;) {
      const result = await client.query(
        catalog
          ? `SELECT id,title,${compact ? `COALESCE(terms,${schema}.title_terms(title))` : 'terms'} AS terms FROM ${schema}.search_title_catalog WHERE id>$1 ORDER BY id LIMIT 1000`
          : `SELECT term,words,documents FROM ${schema}.search_title_terms WHERE term>$1 COLLATE "C" ORDER BY term COLLATE "C" LIMIT 1000`,
        [cursor],
      );
      for (const row of result.rows) {
        hash.update(
          JSON.stringify(
            catalog
              ? [row.id, row.title, JSON.parse(row.terms)]
              : [row.term, row.words, row.documents],
          ) + '\n',
        );
        cursor = catalog ? row.id : row.term;
      }
      if (result.rows.length < 1000) break;
    }
    return hash.digest('hex');
  };
  const before = await measure();
  const catalogHash = await digest(true),
    vocabularyHash = await digest(false);
  await client.query(migration('005_compact_vocabulary.sql'));
  const afterIndex = await measure();
  let after = 0,
    removed = 0,
    compacted = 0,
    exceptions = 0;
  for (;;) {
    const batch = await compactSearchTitleBatch(client, schema, after, 500);
    after = batch.after;
    removed += batch.logicalBytesRemoved;
    compacted += batch.compacted;
    exceptions += batch.exceptions;
    if (batch.complete) break;
  }
  if (
    catalogHash !== (await digest(true, true)) ||
    vocabularyHash !== (await digest(false))
  )
    throw new Error('Storage benchmark logical hashes differ.');
  await client.query(`VACUUM (FULL,ANALYZE) ${schema}.search_title_catalog`);
  const final = await measure();
  const plan = (
    await client.query(
      `EXPLAIN (ANALYZE,FORMAT JSON) SELECT term FROM ${schema}.search_title_terms WHERE replace(term,' ','')=$1`,
      ['shabbosvocabularyaaaab'],
    )
  ).rows[0]['QUERY PLAN'][0];
  const report = {
    measuredAt: new Date().toISOString(),
    scope:
      'Isolated synthetic PostgreSQL benchmark; not the production archive.',
    titles: count,
    before,
    afterIndex,
    afterCompaction: final,
    savedIndexBytes: before.vocabulary_bytes - afterIndex.vocabulary_bytes,
    savedCatalogBytes: before.catalog_bytes - final.catalog_bytes,
    compacted,
    exceptions,
    logicalTermBytesRemoved: removed,
    catalogHash,
    vocabularyHash,
    exactLogicalHashesPreserved: true,
    phraseLookupPlan: plan,
  };
  if (value('--output'))
    writeFileSync(value('--output'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  client.release();
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
}
