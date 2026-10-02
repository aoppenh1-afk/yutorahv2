import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { refreshTitleCatalog } from '../lib/title-catalog';
import { seedCachedTitles } from '../lib/title-index';
import { d1HttpDatabase } from '../lib/d1-http';
import { migrateTitleArchive } from '../lib/title-migration';
import type { SearchDatabase, SearchStatement } from '../lib/search-storage';
import type { Pool } from 'pg';

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? '' : (args[index + 1] ?? '');
};
const pages = Number(value('--pages') || 20);
const bulk = args.includes('--bulk');
const concurrency = Number(value('--concurrency') || 4);
if (!Number.isInteger(pages) || pages < 1 || pages > 1000)
  throw new Error('--pages must be between 1 and 1000.');
let sqlite: DatabaseSync | undefined;
let postgres: Pool | undefined;
let db: SearchDatabase;
if (args.includes('--local') || args.includes('--sqlite')) {
  let filename = value('--sqlite');
  if (!filename) {
    const directory = resolve(
      '.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
    );
    const files = readdirSync(directory).filter(
      (file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite',
    );
    if (files.length !== 1)
      throw new Error('Select the search database with --sqlite PATH.');
    filename = resolve(directory, files[0]);
  }
  sqlite = new DatabaseSync(filename);
  sqlite.exec(
    'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA cache_size=-65536;',
  );
  const prepare = (sql: string, params: unknown[] = []): SearchStatement => ({
    bind: (...values) => prepare(sql, values),
    first: async <T>() =>
      (sqlite!
        .prepare(sql)
        .get(...(params as (string | number | null)[])) as T) ?? null,
    all: async <T>() => ({
      results: sqlite!
        .prepare(sql)
        .all(...(params as (string | number | null)[])) as T[],
    }),
    run: async () => ({
      meta: {
        changes: Number(
          sqlite!.prepare(sql).run(...(params as (string | number | null)[]))
            .changes,
        ),
      },
    }),
  });
  db = {
    prepare,
    batch: async (statements) => {
      sqlite!.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite!.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite!.exec('ROLLBACK');
        throw error;
      }
    },
  };
} else if (process.env.SEARCH_DATABASE_URL) {
  const { postgresSearchPool, postgresSearchDatabase } =
    await import('../lib/search-postgres');
  postgres = postgresSearchPool(process.env.SEARCH_DATABASE_URL);
  db = postgresSearchDatabase(postgres);
} else {
  db = d1HttpDatabase({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    databaseId: process.env.SEARCH_D1_DATABASE_ID || '',
    token: process.env.SEARCH_D1_API_TOKEN || '',
  });
}
try {
  if (args.includes('--restart'))
    await db
      .prepare(
        bulk
          ? "DELETE FROM search_title_imports WHERE name='archive'"
          : "DELETE FROM search_title_cursors WHERE name='archive'",
      )
      .run();
  while (await seedCachedTitles(db)) {
    /* Preserve existing cached titles first. */
  }
  const passes = args.includes('--all') ? Infinity : 1;
  for (let pass = 0; pass < passes; pass++) {
    const result = bulk
      ? await migrateTitleArchive(db, pages, concurrency)
      : await refreshTitleCatalog(db, pages);
    console.log(JSON.stringify(result));
    if (result.complete) break;
  }
} finally {
  sqlite?.close();
  await postgres?.end();
}
