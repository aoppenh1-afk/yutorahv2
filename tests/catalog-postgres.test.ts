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
      for (let index = 0; index < 254; index++)
        await first.save('retained:' + index, { index });
      await db
        .prepare(
          "INSERT INTO catalog_snapshots(resource,version,payload,bytes,updated,expires) VALUES('already-expired','old','old',3,0,1)",
        )
        .run();
      const before = await db
        .prepare('SELECT * FROM catalog_snapshots ORDER BY resource,version')
        .all();
      for (const failure of ['lost', 'expired']) {
        const resource = failure + '-at-capacity';
        await assert.rejects(
          first.read(resource, async () => {
            await db
              .prepare(
                failure === 'lost'
                  ? "UPDATE catalog_refresh_leases SET owner='successor' WHERE resource=?"
                  : 'UPDATE catalog_refresh_leases SET expires=1 WHERE resource=?',
              )
              .bind(resource)
              .run();
            return { rejected: true };
          }),
          SnapshotBusyError,
        );
        assert.deepEqual(
          await db
            .prepare(
              'SELECT * FROM catalog_snapshots ORDER BY resource,version',
            )
            .all(),
          before,
          'rejected publication must leave every existing snapshot unchanged',
        );
      }
      const committing = createPublicSnapshots({
        database: () => ({
          ...db,
          batch: (statements) =>
            db.batch([
              statements[0],
              db.prepare(
                "UPDATE catalog_refresh_leases SET expires=1 WHERE resource='committing'",
              ),
              ...statements.slice(1),
            ]),
        }),
      });
      await committing.save('committing', { committed: true });
      assert.equal(
        Number(
          (
            await db
              .prepare('SELECT COUNT(*) AS count FROM catalog_snapshots')
              .first<{ count: number }>()
          )?.count,
        ),
        256,
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
