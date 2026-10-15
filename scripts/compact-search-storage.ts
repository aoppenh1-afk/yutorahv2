import { Pool } from 'pg';
import {
  compactSearchTitleBatch,
  searchSchemaName,
} from '../lib/search-compaction';
import { refreshSpellingKeys } from '../lib/title-index';
import { postgresSearchDatabase } from '../lib/search-postgres';

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? '' : (args[index + 1] ?? '');
};
if (!process.env.SEARCH_MIGRATION_DATABASE_URL)
  throw new Error(
    'Set SEARCH_MIGRATION_DATABASE_URL to the search schema owner connection.',
  );
const schema = searchSchemaName(value('--schema') || 'yutorah_search');
const pool = new Pool({
  connectionString: process.env.SEARCH_MIGRATION_DATABASE_URL,
  max: 2,
});
const client = await pool.connect();
try {
  await client.query("SET lock_timeout='3s'");
  const measure = async () =>
    (
      await client.query(`SELECT
    pg_database_size(current_database())::bigint AS database_bytes,
    pg_total_relation_size('${schema}.search_title_catalog')::bigint AS catalog_bytes,
    pg_total_relation_size('${schema}.search_title_terms')::bigint AS vocabulary_bytes,
    (SELECT count(*)::int FROM ${schema}.search_title_catalog WHERE terms IS NOT NULL) AS stored_term_lists,
    (SELECT COALESCE(sum(octet_length(terms)),0)::bigint FROM ${schema}.search_title_catalog) AS stored_term_bytes`)
    ).rows[0];
  console.log(JSON.stringify({ phase: 'before', ...(await measure()) }));
  if (args.includes('--apply')) {
    const batchSize = Number(value('--batch') || 500);
    let after = Number(value('--after') || 0);
    do {
      const progress = await compactSearchTitleBatch(
        client,
        schema,
        after,
        batchSize,
      );
      console.log(JSON.stringify({ phase: 'compact', ...progress }));
      after = progress.after;
      if (progress.complete) break;
    } while (args.includes('--all'));
  }
  if (args.includes('--reclaim')) {
    if (!args.includes('--apply'))
      throw new Error('--reclaim requires --apply.');
    const capacity = (
      await client.query(`SELECT current_setting('neon.max_cluster_size',true) AS maximum,
      (SELECT sum(pg_database_size(oid))::bigint FROM pg_database) AS cluster_bytes,
      pg_total_relation_size('${schema}.search_title_catalog')::bigint AS rewrite_bytes`)
    ).rows[0];
    if (capacity.maximum && capacity.maximum !== '-1') {
      const maximum = (
        await client.query('SELECT pg_size_bytes($1)::bigint AS bytes', [
          capacity.maximum,
        ])
      ).rows[0].bytes;
      if (
        Number(capacity.cluster_bytes) +
          Number(capacity.rewrite_bytes) +
          8 * 1024 * 1024 >
        Number(maximum)
      )
        throw new Error(
          'Insufficient project headroom for the catalog rewrite. Logical compaction is retained; reclaim later.',
        );
    }
    await client.query(`VACUUM (FULL, ANALYZE) ${schema}.search_title_catalog`);
  }
  if (args.includes('--keys')) {
    if (!args.includes('--apply'))
      throw new Error('--keys writes new spelling keys; use --apply.');
    const db = postgresSearchDatabase(pool, schema);
    let after = value('--after-word');
    do {
      const progress = await refreshSpellingKeys(db, after);
      console.log(JSON.stringify({ phase: 'keys', ...progress }));
      after = progress.after;
      if (progress.complete) break;
    } while (args.includes('--all'));
  }
  console.log(
    JSON.stringify({
      phase: 'after',
      ...(await measure()),
      applied: args.includes('--apply'),
    }),
  );
} finally {
  client.release();
  await pool.end();
}
