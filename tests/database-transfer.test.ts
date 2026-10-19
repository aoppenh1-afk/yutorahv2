import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  postgresSearchDatabase,
  postgresSearchPool,
} from '../lib/search-postgres';
import {
  transferFeature,
  transferReporter,
  type TransferCount,
} from '../lib/database-transfer';

void test('traffic labels are fixed categories and never contain SQL parameters', () => {
  assert.equal(
    transferFeature('SELECT payload FROM yutorah_search.catalog_snapshots'),
    'catalog',
  );
  assert.equal(
    transferFeature('SELECT plan FROM yutorah_search.search_runs WHERE id=$1', [
      'trending:v1:shared:2',
    ]),
    'charts',
  );
  assert.equal(
    transferFeature('SELECT payload FROM yutorah_search.search_documents'),
    'search_results',
  );
  assert.equal(
    transferFeature('SELECT text FROM yutorah_search.search_note_documents'),
    'notes_index',
  );
  assert.equal(
    transferFeature('SELECT secret_customer_sql', ['private password']),
    'other',
  );
});

void test(
  'query-local byte counts preserve types, include transactions and persist through a one-connection pool',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = postgresSearchPool(process.env.TEST_DATABASE_URL!);
    const schema = 'traffic_' + randomUUID().replaceAll('-', '');
    const messages: string[] = [];
    t.mock.method(console, 'log', (message: string) => messages.push(message));
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        (
          await readFile(
            'db/search-postgres/007_transfer_accounting.sql',
            'utf8',
          )
        ).replaceAll('yutorah_search', schema),
      );
      // There is no spare connection while a batch is running. Accounting must
      // release the application client before it writes the counter.
      pool.options.max = 1;
      const measured: TransferCount[][] = [];
      const persist = transferReporter(pool, 'library', schema);
      const db = postgresSearchDatabase(pool, schema, async (counts) => {
        measured.push(counts);
        await persist(counts);
      });
      const secret = 'private query ש';
      const response = await db
        .prepare(
          'SELECT ?::text AS value,42::bigint AS n,NULL::text AS missing,?::json AS document',
        )
        .bind(secret, '{ "answer": 42 }')
        .first<{
          value: string;
          n: number;
          missing: null;
          document: { answer: number };
        }>();
      assert.deepEqual(response, {
        value: secret,
        n: 42,
        missing: null,
        document: { answer: 42 },
      });
      assert.equal(
        measured[0][0].columnBytes,
        Buffer.byteLength(secret) + 2 + Buffer.byteLength('{ "answer": 42 }'),
      );
      assert.equal(measured[0][0].rows, 1);
      await db.batch([db.prepare('SELECT ?::text AS value').bind('second')]);
      const counts = (
        await pool.query(
          `SELECT sum(queries)::int AS queries,sum(rows)::int AS rows,sum(column_bytes)::int AS bytes FROM ${schema}.database_transfer_daily`,
        )
      ).rows[0];
      assert.equal(
        counts.queries,
        4,
        'One read plus BEGIN, SELECT and COMMIT are counted exactly once',
      );
      assert.equal(counts.rows, 2);
      assert.equal(
        counts.bytes,
        measured.flat().reduce((sum, c) => sum + c.columnBytes, 0),
      );
      await assert.rejects(
        db.prepare('SELECT nonexistent_private_column').all(),
      );
      assert.equal(measured.at(-1)![0].errors, 1);
      assert.ok(messages.length > 0);
      assert.doesNotMatch(
        messages.join('\n'),
        /private query|nonexistent_private_column|answer|password/,
      );
      // A storage failure only loses telemetry, never an otherwise valid result.
      await pool.query(`DROP TABLE ${schema}.database_transfer_daily`);
      t.mock.method(console, 'warn', (message: string) =>
        messages.push(message),
      );
      assert.deepEqual(await db.prepare('SELECT 1::int AS n').first(), {
        n: 1,
      });
      assert.ok(
        messages.some(
          (m) => JSON.parse(m).event === 'database_transfer_store_unavailable',
        ),
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  },
);
