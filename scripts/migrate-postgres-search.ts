import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { postgresSearchDatabase } from '../lib/search-postgres';
import { checkSearchSchema } from './check-search-schema';

/** Explicit release step: owner-only, serialized, versioned and restartable. */
export async function migratePostgresSearch(
  connectionString: string,
  schema = 'yutorah_search',
) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema))
    throw new Error('Invalid search schema.');
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(1790900496,0)');
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const applied = new Set(
        (
          await client.query<{ id: string }>(
            `SELECT id FROM ${schema}.schema_migrations`,
          )
        ).rows.map((row) => row.id),
      );
      for (const file of (await readdir('db/search-postgres'))
        .filter((file) => file.endsWith('.sql'))
        .sort()) {
        if (applied.has(file)) continue;
        await client.query('BEGIN');
        try {
          await client.query(
            (await readFile('db/search-postgres/' + file, 'utf8')).replace(
              /\byutorah_search\b/g,
              schema,
            ),
          );
          await client.query(
            `INSERT INTO ${schema}.schema_migrations(id) VALUES($1)`,
            [file],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(1790900496,0)')
        .catch(() => {});
      client.release();
    }
    await checkSearchSchema(postgresSearchDatabase(pool, schema), schema);
  } finally {
    await pool.end();
  }
}
