import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { SearchDatabase } from '../lib/search-storage';
import { d1HttpDatabase } from '../lib/d1-http';

/** Compatibility validation is deliberately read-only for the runtime role. */
export async function checkSearchSchema(
  db: SearchDatabase,
  postgresSchema = 'yutorah_search',
) {
  for (const sql of [
    'SELECT id,next,scanned,owner FROM search_runs LIMIT 0',
    'SELECT run,owner,valid FROM search_pass_guards LIMIT 0',
    'SELECT key,payload FROM search_documents LIMIT 0',
    'SELECT fingerprint,owner FROM search_creation_leases LIMIT 0',
    'SELECT name,bytes FROM search_cache_usage LIMIT 0',
    'SELECT id,title,terms FROM search_title_catalog LIMIT 0',
    'SELECT key,term FROM search_title_keys LIMIT 0',
    'SELECT id,payload,lease,expires FROM sources_runs LIMIT 0',
  ])
    await db.prepare(sql).all();
  if (db.dialect === 'postgres') {
    const generator = await db
      .prepare('SELECT to_regprocedure(?) AS implementation')
      .bind(`${postgresSchema}.title_terms(text)`)
      .first<{ implementation: string | null }>();
    const compact = await db
      .prepare(
        "SELECT indexname FROM pg_indexes WHERE schemaname=? AND tablename='search_title_terms' AND indexname='search_title_compact_hash'",
      )
      .bind(postgresSchema)
      .first();
    if (!compact || !generator?.implementation)
      throw new Error(
        'Missing compact vocabulary migration. Run search:schema:migrate with the schema owner before activating this release.',
      );
    const index = await db
      .prepare(
        "SELECT indexname FROM pg_indexes WHERE schemaname=? AND tablename='search_title_catalog' AND indexname='search_title_autocomplete'",
      )
      .bind(postgresSchema)
      .first();
    if (!index)
      throw new Error(
        'Missing search autocomplete index. Run search:schema:migrate with the schema owner before activating this release.',
      );
  } else
    await db.prepare('SELECT id FROM search_title_autocomplete LIMIT 0').all();
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.env.SEARCH_DATABASE_URL) {
    const { postgresSearchPool, postgresSearchDatabase } =
      await import('../lib/search-postgres');
    const pool = postgresSearchPool(process.env.SEARCH_DATABASE_URL);
    try {
      await checkSearchSchema(postgresSearchDatabase(pool));
    } finally {
      await pool.end();
    }
  } else {
    await checkSearchSchema(
      d1HttpDatabase({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
        databaseId: process.env.SEARCH_D1_DATABASE_ID || '',
        token: process.env.SEARCH_D1_API_TOKEN || '',
      }),
    );
  }
  console.log('Search schema compatibility verified.');
}
