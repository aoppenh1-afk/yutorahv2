import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { d1HttpDatabase } from '../lib/d1-http';
import type { SearchDatabase } from '../lib/search-storage';

// These additive migrations must run before the new website can query titles.
// Use the authoritative SQL files, retaining whole trigger bodies.
export function titleSchemaStatements(directory = resolve('drizzle')) {
  return [
    '0002_title_vocabulary.sql',
    '0003_title_import_checkpoint.sql',
    '0004_title_autocomplete.sql',
  ]
    .flatMap((name) =>
      readFileSync(resolve(directory, name), 'utf8')
        .split('--> statement-breakpoint')
        .map((sql) => sql.replace(/^--[^\n]*\n/gm, '').trim())
        .filter(Boolean),
    )
    .map((sql) => {
      if (
        sql ===
          "INSERT INTO search_title_autocomplete(search_title_autocomplete) VALUES('rebuild');" ||
        sql ===
          "INSERT OR IGNORE INTO search_title_cursors(name,next) VALUES('title-autocomplete-v1',1);"
      )
        return sql;
      if (!/^CREATE (?:VIRTUAL TABLE|TABLE|TRIGGER)\s/i.test(sql))
        throw new Error('Title schema setup accepts additive migrations only.');
      return sql.replace(
        /^CREATE (VIRTUAL TABLE|TABLE|TRIGGER)\s/i,
        'CREATE $1 IF NOT EXISTS ',
      );
    });
}

export async function migrateTitleSchema(db: SearchDatabase) {
  // Each statement is idempotent, including after an interrupted build.
  for (const sql of titleSchemaStatements()) {
    if (sql.startsWith('INSERT INTO search_title_autocomplete')) {
      const built = await db
        .prepare(
          "SELECT next FROM search_title_cursors WHERE name='title-autocomplete-v1'",
        )
        .first();
      if (built) continue;
    }
    await db.prepare(sql).run();
  }
  await db
    .prepare('SELECT id,title,terms FROM search_title_catalog LIMIT 0')
    .all();
  await db
    .prepare('SELECT term,words,documents FROM search_title_terms LIMIT 0')
    .all();
  await db.prepare('SELECT key,term FROM search_title_keys LIMIT 0').all();
  await db.prepare('SELECT name,next FROM search_title_cursors LIMIT 0').all();
  await db
    .prepare('SELECT name,completed FROM search_title_imports LIMIT 0')
    .all();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.env.SEARCH_DATABASE_URL) {
    const { postgresSearchDatabase, postgresSearchPool } =
      await import('../lib/search-postgres');
    const pool = postgresSearchPool(process.env.SEARCH_DATABASE_URL);
    try {
      const db = postgresSearchDatabase(pool);
      await db
        .prepare('SELECT id,title,terms FROM search_title_catalog LIMIT 0')
        .all();
      await db.prepare('SELECT key,term FROM search_title_keys LIMIT 0').all();
      await db.prepare('SELECT id,next FROM search_runs LIMIT 0').all();
      const index = await pool.query(
        "SELECT 1 FROM pg_indexes WHERE schemaname='yutorah_search' AND indexname='search_title_autocomplete'",
      );
      if (!index.rowCount)
        throw new Error(
          'Apply db/search-postgres/002_autocomplete.sql with the search migration owner before deploying.',
        );
      console.log('Managed PostgreSQL search schema ready.');
    } finally {
      await pool.end();
    }
  } else {
    const config = {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
      databaseId: process.env.SEARCH_D1_DATABASE_ID || '',
      token: process.env.SEARCH_D1_API_TOKEN || '',
    };
    if (
      !process.env.VERCEL &&
      !config.accountId &&
      !config.databaseId &&
      !config.token
    ) {
      console.log('Local Vercel build: remote search migrations skipped.');
    } else {
      await migrateTitleSchema(d1HttpDatabase(config));
      console.log('Search title schema ready.');
    }
  }
}
