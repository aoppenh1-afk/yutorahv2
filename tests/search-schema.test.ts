import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { migratePostgresSearch } from '../scripts/migrate-postgres-search.js';
import { checkSearchSchema } from '../scripts/check-search-schema.js';
import { postgresSearchDatabase } from '../lib/search-postgres.js';
import { env } from '../lib/vercel-bindings.js';

void test(
  'release migrations resume partial schemas, serialize overlap and permit read-only compatibility checks',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'release_' + randomUUID().replaceAll('-', '');
    const role = 'reader_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    let runtime: Pool | undefined;
    let roleCreated = false;
    try {
      await admin.query(
        (await readFile('db/search-postgres/001_search.sql', 'utf8')).replace(
          /\byutorah_search\b/g,
          schema,
        ),
      );
      await admin.query(
        `INSERT INTO ${schema}.search_title_catalog VALUES(42,'Preserved title','[]')`,
      );
      await assert.rejects(
        checkSearchSchema(postgresSearchDatabase(admin, schema), schema),
        /owner|does not exist/,
      );
      await Promise.all([
        migratePostgresSearch(process.env.TEST_DATABASE_URL!, schema),
        migratePostgresSearch(process.env.TEST_DATABASE_URL!, schema),
      ]);
      assert.equal(
        (
          await admin.query(
            `SELECT COUNT(*)::int AS n FROM ${schema}.schema_migrations`,
          )
        ).rows[0].n,
        (await readdir('db/search-postgres')).filter((file) =>
          file.endsWith('.sql'),
        ).length,
      );
      assert.equal(
        (
          await admin.query(
            `SELECT title FROM ${schema}.search_title_catalog WHERE id=42`,
          )
        ).rows[0].title,
        'Preserved title',
      );
      const definition = async () =>
        (
          await admin.query(
            'SELECT pg_get_functiondef(to_regprocedure($1)) AS source',
            [`${schema}.title_changed()`],
          )
        ).rows[0].source;
      const beforeReplay = await definition();
      await admin.query(`INSERT INTO ${schema}.search_runs(id,fingerprint,plan,total,created) VALUES('bad-cache','bad','{}',1,1);
        INSERT INTO ${schema}.search_hits(run,id,payload,matched,rank,date,duration,title,position) VALUES('bad-cache',1,'invalid json',1,1,1,1,'bad',1);
        DELETE FROM ${schema}.schema_migrations`);
      await assert.rejects(
        migratePostgresSearch(process.env.TEST_DATABASE_URL!, schema),
        /invalid input syntax for type json/,
      );
      assert.equal(
        await definition(),
        beforeReplay,
        'A failed replay must restore compact-aware triggers',
      );
      await admin.query(
        `DELETE FROM ${schema}.search_runs WHERE id='bad-cache'`,
      );
      await migratePostgresSearch(process.env.TEST_DATABASE_URL!, schema);
      await admin.query(`CREATE ROLE ${role}`);
      roleCreated = true;
      await admin.query(
        `GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
      );
      runtime = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c role=${role}`,
        max: 1,
      });
      await checkSearchSchema(postgresSearchDatabase(runtime, schema), schema);
      await assert.rejects(
        runtime.query(`CREATE TABLE ${schema}.unauthorized(id int)`),
        /permission denied/,
      );
      await assert.rejects(
        migratePostgresSearch(
          'postgresql://fixture:fixture@127.0.0.1:1/fixture?connect_timeout=1',
        ),
        /ECONNREFUSED/,
      );
    } finally {
      await runtime?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (roleCreated) await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  },
);

void test('Vercel D1 fallback preserves adapter identity and invalidates changed runtime credentials', () => {
  const keys = [
    'SEARCH_DATABASE_URL',
    'CLOUDFLARE_ACCOUNT_ID',
    'SEARCH_D1_DATABASE_ID',
    'SEARCH_D1_API_TOKEN',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.SEARCH_DATABASE_URL;
    process.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
    process.env.SEARCH_D1_DATABASE_ID = randomUUID();
    process.env.SEARCH_D1_API_TOKEN = 'fixture-one';
    const first = env.DB;
    assert.equal(env.DB, first);
    process.env.SEARCH_D1_API_TOKEN = 'fixture-two';
    const second = env.DB;
    assert.notEqual(second, first);
    assert.equal(env.DB, second);
    process.env.SEARCH_D1_DATABASE_ID = randomUUID();
    assert.notEqual(env.DB, second);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
