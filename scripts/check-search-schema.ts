import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { SearchDatabase } from '../lib/search-storage';
import { d1HttpDatabase } from '../lib/d1-http';
import { routeSearchStorage } from '../lib/search-storage-routing';

export async function checkNotesSearchSchema(
  db: SearchDatabase,
  postgresSchema = 'yutorah_search',
) {
  for (const sql of [
    'SELECT id,created,completed,count FROM search_note_snapshots LIMIT 0',
    'SELECT key,id,notes_hash,payload,text,normalized FROM search_note_documents LIMIT 0',
    'SELECT snapshot,id,key FROM search_note_members LIMIT 0',
    'SELECT name,snapshot,cursor,owner,lease,updated FROM search_notes_state LIMIT 0',
  ])
    await db.prepare(sql).all();
  if (db.dialect === 'postgres') {
    const index = await db
      .prepare(
        "SELECT indexname FROM pg_indexes WHERE schemaname=? AND tablename='search_note_documents' AND indexname='search_note_fulltext'",
      )
      .bind(postgresSchema)
      .first();
    if (!index)
      throw new Error(
        'Missing notes full-text index in the notes search database.',
      );
  }
}

/** Compatibility validation is deliberately read-only for the runtime role. */
export async function checkSearchSchema(
  db: SearchDatabase,
  postgresSchema = 'yutorah_search',
) {
  for (const sql of [
    'SELECT resource,version,payload,bytes,updated,expires FROM catalog_snapshots LIMIT 0',
    'SELECT resource,owner,expires FROM catalog_refresh_leases LIMIT 0',
    'SELECT id,image,updated FROM catalog_artwork LIMIT 0',
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
    const notesPool = process.env.NOTES_SEARCH_DATABASE_URL
      ? postgresSearchPool(process.env.NOTES_SEARCH_DATABASE_URL)
      : undefined;
    try {
      const library = postgresSearchDatabase(pool);
      const notes = notesPool && postgresSearchDatabase(notesPool);
      await checkSearchSchema(
        notes ? routeSearchStorage(library, notes) : library,
      );
      if (notes) await checkNotesSearchSchema(notes);
    } finally {
      await pool.end();
      await notesPool?.end();
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
