import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

void test(
  'library RPC preserves private accounts, deletions, counters and atomic quotas',
  { skip: !process.env.NOTIFICATION_TEST_DATABASE_URL },
  async () => {
    const db = new Client({
      connectionString: process.env.NOTIFICATION_TEST_DATABASE_URL,
    });
    await db.connect();
    try {
      await db.query('begin');
      await db.query(`create role anon;create role authenticated;create role service_role;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;
      insert into auth.users values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');`);
      await db.query(
        await readFile(
          'supabase/migrations/202610110008_account_library.sql',
          'utf8',
        ),
      );
      await db.query(
        await readFile(
          'supabase/migrations/202610130009_catalog_follows.sql',
          'utf8',
        ),
      );
      const a = '00000000-0000-0000-0000-000000000001',
        b = '00000000-0000-0000-0000-000000000002';
      const as = async (id: string) => {
        await db.query('reset role');
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
          id,
        ]);
        await db.query('set local role authenticated');
      };
      const change = (
        key: string,
        value: unknown,
        base_version = 0,
        deleted = false,
      ) => ({
        key,
        value,
        base_version,
        deleted,
        operation: crypto.randomUUID(),
      });
      const sync = async (changes: unknown[] = [], since = 0) =>
        (
          await db.query(
            'select public.sync_account_library($1,$2) as result',
            [JSON.stringify(changes), since],
          )
        ).rows[0].result;
      await as(a);
      const saved = change('saved:42', { id: 42, index: 0 });
      const first = await sync([saved]);
      assert.equal(first.resolved[0].version, 1);
      assert.equal(
        (await sync([saved])).revision,
        1,
        'Lost-response retries are acknowledgements',
      );
      const deleted = await sync([change('saved:42', null, 1, true)]);
      assert.equal(deleted.resolved[0].deleted, true);
      const stale = await sync([change('saved:42', { id: 42, index: 0 })]);
      assert.deepEqual(stale.conflicts, ['saved:42']);
      assert.equal(
        stale.resolved[0].deleted,
        true,
        'A stale import cannot revive a deletion',
      );
      assert.equal(
        (await sync([], first.revision)).items[0].deleted,
        true,
        'Incremental reads include tombstones',
      );
      const day = 'day:2026-10-11:00000000-0000-0000-0000-000000000001';
      await sync([change(day, 30)]);
      await sync([change(day, 20)]);
      assert.equal(
        (await sync()).items.find((r: { key: string }) => r.key === day).value,
        30,
        'Counters never shrink',
      );
      for (const kind of ['topic', 'series', 'venue', 'collection']) {
        const key = `follow:${kind}:7`,
          value = {
            kind,
            id: 7,
            name: 'Followed ' + kind,
            image: 'https://example.test/cover.jpg',
          };
        const created = await sync([change(key, value)]);
        assert.deepEqual(
          (await sync()).items.find((r: { key: string }) => r.key === key)
            .value,
          value,
          'Another device restores the complete follow',
        );
        const version = created.resolved[0].version;
        const unfollowed = await sync([change(key, null, version, true)]);
        assert.deepEqual(
          (await sync([change(key, value)])).conflicts,
          [key],
          'Stale imports cannot revive an unfollow',
        );
        await db.query('savepoint invalid_follow');
        await assert.rejects(
          sync([
            change(key, { ...value, id: 8 }, unfollowed.resolved[0].version),
          ]),
          /Invalid library follow/,
        );
        await db.query('rollback to savepoint invalid_follow');
      }
      for (const key of [
        'follow:teacher:1',
        'follow:unknown:1',
        'follow:venue:0',
      ]) {
        await db.query('savepoint invalid_kind');
        await assert.rejects(
          sync([change(key, { kind: 'venue', id: 1, name: 'Venue' })]),
          /Invalid library follow/,
        );
        await db.query('rollback to savepoint invalid_kind');
      }
      await as(b);
      assert.deepEqual((await sync()).items, []);
      assert.equal(
        (await db.query('select * from public.library_items')).rowCount,
        0,
        'RLS hides the other account',
      );
      await db.query('savepoint direct_write');
      await assert.rejects(
        db.query("update public.library_items set value='{}'"),
        /permission denied/,
      );
      await db.query('rollback to savepoint direct_write');
      await db.query('reset role');
      assert.equal(
        (
          await db.query(
            "select has_function_privilege('anon','public.sync_account_library(jsonb,bigint)','execute') as allowed",
          )
        ).rows[0].allowed,
        false,
      );
      await db.query(
        'update public.library_profiles set storage_bytes=10485600 where user_id=$1',
        [b],
      );
      await as(b);
      await db.query('savepoint quota');
      await assert.rejects(
        sync([
          change('saved:1', { id: 1, index: 0 }),
          change('saved:2', { id: 2, index: 1 }),
        ]),
        /storage limit/,
      );
      await db.query('rollback to savepoint quota');
      assert.equal(
        (await db.query('select * from public.library_items')).rowCount,
        0,
        'Quota errors roll back the whole batch',
      );
      await db.query('reset role');
      await db.query('delete from auth.users where id=$1', [a]);
      assert.equal(
        (await db.query('select * from public.library_items')).rowCount,
        0,
        'Deleting an account deletes its library',
      );
    } finally {
      await db.query('rollback');
      await db.end();
    }
  },
);
