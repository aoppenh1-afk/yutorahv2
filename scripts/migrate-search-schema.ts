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
    '0005_sources.sql',
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
      if (!/^CREATE (?:VIRTUAL TABLE|TABLE|TRIGGER|INDEX)\s/i.test(sql))
        throw new Error('Title schema setup accepts additive migrations only.');
      return sql.replace(
        /^CREATE (VIRTUAL TABLE|TABLE|TRIGGER|INDEX)(?: IF NOT EXISTS)?\s/i,
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

export async function migrateSourcesSchema(db: SearchDatabase) {
  // Epoch milliseconds require bigint in PostgreSQL; SQLite integer is 64-bit.
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS sources_runs (id text PRIMARY KEY,payload text NOT NULL,lease bigint NOT NULL DEFAULT 0,expires bigint NOT NULL)',
    )
    .run();
  await db
    .prepare(
      'CREATE INDEX IF NOT EXISTS sources_runs_expires ON sources_runs (expires)',
    )
    .run();
}

export async function migrateEfficiencySchema(db: SearchDatabase) {
  const columns: Record<string, string[]> = {};
  for (const table of ['search_runs', 'search_hits']) {
    columns[table] = (
      await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    ).results.map((row) => row.name);
  }
  const statements = readFileSync(
    resolve('drizzle/0006_search_efficiency.sql'),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    const alter = sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/);
    if (alter && columns[alter[1]].includes(alter[2])) continue;
    await db
      .prepare(
        sql
          .replace(/^CREATE (TABLE|INDEX|TRIGGER) /, 'CREATE $1 IF NOT EXISTS ')
          .replace(
            /^INSERT INTO search_cache_usage/,
            'INSERT OR IGNORE INTO search_cache_usage',
          ),
      )
      .run();
  }
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
      // Owner-created tables let the normal website role run without DDL access.
      try {
        await db
          .prepare('SELECT id,payload,lease,expires FROM sources_runs LIMIT 0')
          .all();
      } catch {
        try {
          await migrateSourcesSchema(db);
        } catch {
          throw new Error(
            'Apply db/search-postgres/002_sources.sql with the search schema owner and grant the website search role SELECT, INSERT, UPDATE, DELETE before deploying.',
          );
        }
      }
      await db
        .prepare('SELECT id,title,terms FROM search_title_catalog LIMIT 0')
        .all();
      await db.prepare('SELECT key,term FROM search_title_keys LIMIT 0').all();
      try {
        await db
          .prepare('SELECT id,next,scanned FROM search_runs LIMIT 0')
          .all();
        await db
          .prepare('SELECT key,payload FROM search_documents LIMIT 0')
          .all();
        await db
          .prepare('SELECT name,bytes FROM search_cache_usage LIMIT 0')
          .all();
        await db
          .prepare(
            'SELECT fingerprint,owner FROM search_creation_leases LIMIT 0',
          )
          .all();
      } catch {
        throw new Error(
          'Apply db/search-postgres/003_efficiency.sql with the schema owner and grant the website role access to the new tables before deploying.',
        );
      }
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
      const db = d1HttpDatabase(config);
      await migrateTitleSchema(db);
      await migrateEfficiencySchema(db);
      console.log('Search title schema ready.');
    }
  }
}
