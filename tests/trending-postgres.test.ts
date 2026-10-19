import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { postgresSearchDatabase } from '../lib/search-postgres';
import { serializeTrendingPlan, trendingPlanSql } from '../lib/trending-cache';
import { gunzipSync } from 'node:zlib';
import type { TransferCount } from '../lib/database-transfer';

void test(
  'PostgreSQL validates checkpoint versions and active leases without returning scan payloads',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = 'trending_' + randomUUID().replaceAll('-', '');
    const key = 'trending:v1:shared:2';
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        `CREATE TABLE ${schema}.search_runs(id text PRIMARY KEY,fingerprint text,plan text,lease bigint)`,
      );
      const state = {
        checkpointVersion: randomUUID(),
        snapshot: { seen: randomBytes(100_000).toString('base64') },
      };
      const packed = () =>
        serializeTrendingPlan(
          state as unknown as Parameters<typeof serializeTrendingPlan>[0],
        );
      await pool.query(`INSERT INTO ${schema}.search_runs VALUES($1,$1,$2,0)`, [
        key,
        packed(),
      ]);
      const counts: TransferCount[] = [];
      const db = postgresSearchDatabase(pool, schema, async (batch) => {
        counts.push(...batch);
      });
      const read = (version: string, publicOnly = false) =>
        db
          .prepare(trendingPlanSql(db, publicOnly, { skipLeased: !publicOnly }))
          .bind(...(!publicOnly ? [1000] : []), version, key, key)
          .first<{ plan: string | null; version: string; lease?: string }>();
      assert.ok((await read(''))!.plan);
      const coldBytes = counts.at(-1)!.columnBytes;
      assert.ok(coldBytes > 100_000);
      assert.equal((await read(state.checkpointVersion))!.plan, null);
      const warmBytes = counts.at(-1)!.columnBytes;
      assert.ok(warmBytes < 128, 'Unchanged state must not leave PostgreSQL');
      assert.equal((await read(state.checkpointVersion, true))!.plan, null);
      const firstVersion = state.checkpointVersion;
      state.checkpointVersion = randomUUID();
      await pool.query(`UPDATE ${schema}.search_runs SET plan=$1`, [packed()]);
      assert.equal(
        (await read(firstVersion))!.version,
        state.checkpointVersion,
      );
      assert.ok(
        counts.at(-1)!.columnBytes > 100_000,
        'Another writer must invalidate the cache',
      );
      await pool.query(`UPDATE ${schema}.search_runs SET lease=2000`);
      const leased = await read('');
      assert.equal(leased!.plan, null);
      assert.equal(Number(leased!.lease), 2000);
      assert.ok(counts.at(-1)!.columnBytes < 128);
      assert.ok(
        (await read('', true))!.plan,
        'Public charts remain readable during the lease',
      );
      for (const legacy of [
        JSON.stringify({ snapshot: state.snapshot }),
        'invalid JSON',
      ]) {
        await pool.query(`UPDATE ${schema}.search_runs SET lease=0,plan=$1`, [
          legacy,
        ]);
        assert.equal(
          (await read(state.checkpointVersion))!.plan,
          legacy,
          'Legacy and corrupt rows must reach the existing validation/recovery path',
        );
      }
      t.diagnostic(
        `Checkpoint columns: cold ${coldBytes} bytes, unchanged ${warmBytes} bytes`,
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  },
);

void test(
  'PostgreSQL removes private chart checkpoints before returning public state and preserves resumable state',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = 'trending_' + randomUUID().replaceAll('-', '');
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        `CREATE TABLE ${schema}.search_runs(id text PRIMARY KEY,fingerprint text,plan text)`,
      );
      const state = {
        snapshot: {
          sampled: 360,
          seen: 'a'.repeat(600_000),
          index: {
            charts: { 'all:0': { ids: [1], total: 360 } },
            items: [{ id: 1 }],
            audit: { seen: 'b'.repeat(600_000), cursor: 12 },
          },
        },
        lastComplete: {
          sampled: 30,
          seen: 'c'.repeat(600_000),
          index: {
            charts: { 'all:0': { ids: [2], total: 30 } },
            items: [{ id: 2 }],
            audit: { seen: 'd'.repeat(600_000) },
          },
        },
      };
      const key = 'trending:v1:shared:2';
      await pool.query(`INSERT INTO ${schema}.search_runs VALUES($1,$1,$2)`, [
        key,
        JSON.stringify(state),
      ]);
      const db = postgresSearchDatabase(pool, schema);
      const projected = await db
        .prepare(trendingPlanSql(db, true))
        .bind(key, key)
        .first<{ plan: string }>();
      assert.ok(projected);
      assert.ok(Buffer.byteLength(projected.plan) < 1000);
      const publicState = JSON.parse(projected.plan);
      for (const part of ['snapshot', 'lastComplete'] as const) {
        assert.equal(publicState[part].seen, undefined);
        assert.equal(publicState[part].index.audit, undefined);
        assert.deepEqual(
          publicState[part].index.charts,
          state[part].index.charts,
        );
        assert.deepEqual(
          publicState[part].index.items,
          state[part].index.items,
        );
      }
      const privateState = await db
        .prepare(trendingPlanSql(db, false))
        .bind(key, key)
        .first<{ plan: string }>();
      assert.deepEqual(JSON.parse(privateState!.plan), state);
      const compatible = serializeTrendingPlan(
        state as unknown as Parameters<typeof serializeTrendingPlan>[0],
      );
      assert.deepEqual(JSON.parse(compatible).snapshot, state.snapshot);
      await pool.query(`UPDATE ${schema}.search_runs SET plan=$1`, [
        compatible,
      ]);
      const packed = await db
        .prepare(trendingPlanSql(db, false))
        .bind(key, key)
        .first<{ plan: string }>();
      assert.match(packed!.plan, /^gzip:v1:/);
      assert.ok(Buffer.byteLength(packed!.plan) < 10_000);
      assert.deepEqual(
        JSON.parse(
          gunzipSync(
            Buffer.from(packed!.plan.slice('gzip:v1:'.length), 'base64'),
          ).toString('utf8'),
        ),
        state,
      );
      const display = await db
        .prepare(trendingPlanSql(db, true))
        .bind(key, key)
        .first<{ plan: string }>();
      assert.match(
        display!.plan,
        /^gzip:v1:/,
        'Public metadata must also cross the wire compressed',
      );
      const publicText = gunzipSync(
        Buffer.from(display!.plan.slice('gzip:v1:'.length), 'base64'),
      ).toString('utf8');
      assert.deepEqual(JSON.parse(publicText), publicState);
      await pool.query(`UPDATE ${schema}.search_runs SET plan=$1`, [
        'corrupt state',
      ]);
      for (const publicOnly of [false, true]) {
        const invalid = await db
          .prepare(trendingPlanSql(db, publicOnly))
          .bind(key, key)
          .first<{ plan: string }>();
        assert.equal(
          invalid!.plan,
          'corrupt state',
          'Invalid JSON must reach the existing recovery path',
        );
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  },
);
