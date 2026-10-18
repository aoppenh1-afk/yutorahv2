import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { migratePostgresSearch } from '../scripts/migrate-postgres-search';
import { postgresSearchDatabase } from '../lib/search-postgres';
import {
  createPublicSnapshots,
  SnapshotBusyError,
} from '../lib/public-snapshots';

void test(
  'PostgreSQL catalog snapshots share immutable generations, fence expired writers and enforce their byte budget',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = 'catalog_' + randomUUID().replaceAll('-', '');
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 2,
    });
    try {
      await migratePostgresSearch(process.env.TEST_DATABASE_URL!, schema);
      const db = postgresSearchDatabase(pool, schema);
      const first = createPublicSnapshots({ database: () => db });
      const original = await first.save('collection:1', { items: [1, 2, 3] });
      const changed = await first.save('collection:1', { items: [1, 2, 3, 4] });
      const peer = createPublicSnapshots({
        database: () => postgresSearchDatabase(pool, schema),
      });
      assert.deepEqual(
        (
          await peer.read(
            'collection:1',
            async () => {
              throw new Error('Unexpected upstream read');
            },
            { version: original.version },
          )
        ).value,
        { items: [1, 2, 3] },
      );
      assert.equal((await peer.peek('collection:1'))?.version, changed.version);
      await assert.rejects(
        first.read('expired', async () => {
          await db
            .prepare(
              "UPDATE catalog_refresh_leases SET expires=1 WHERE resource='expired'",
            )
            .run();
          return { invalid: true };
        }),
        SnapshotBusyError,
      );
      assert.equal(
        await db
          .prepare(
            "SELECT version FROM catalog_snapshots WHERE resource='expired'",
          )
          .first(),
        null,
      );
      const blob = randomBytes(430_000).toString('base64');
      for (let index = 0; index < 32; index++)
        await first.save('budget:' + index, { blob, index });
      const usage = await db
        .prepare(
          'SELECT SUM(bytes) AS bytes,COUNT(*) AS count FROM catalog_snapshots',
        )
        .first<{ bytes: number; count: number }>();
      assert.ok(usage!.bytes <= 16 * 1024 * 1024);
      assert.ok(
        usage!.count < 34,
        'Old snapshots should be evicted before exceeding the budget',
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  },
);
