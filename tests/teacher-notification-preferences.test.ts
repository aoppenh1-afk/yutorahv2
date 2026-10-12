import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

// Run against an empty, disposable PostgreSQL database. Everything rolls back.
const database = process.env.NOTIFICATION_TEST_DATABASE_URL;
void test(
  'teacher alerts are independent, private, and never replay muted uploads',
  { skip: !database },
  async () => {
    const db = new Client({ connectionString: database });
    await db.connect();
    try {
      await db.query('begin');
      await db.query(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      grant usage on schema auth to authenticated;
      insert into auth.users values
        ('00000000-0000-0000-0000-000000000001'),
        ('00000000-0000-0000-0000-000000000002');
    `);
      for (const name of [
        '202610110001_notifications.sql',
        '202610110005_follow_notification_baselines.sql',
        '202610110007_teacher_notification_preferences.sql',
      ]) {
        await db.query(
          await readFile(
            new URL('../supabase/migrations/' + name, import.meta.url),
            'utf8',
          ),
        );
      }
      const userA = '00000000-0000-0000-0000-000000000001';
      const userB = '00000000-0000-0000-0000-000000000002';
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
        userA,
      ]);
      await db.query('set local role authenticated');
      await db.query(
        "select public.set_teacher_follow(10,'Teacher',null,true)",
      );
      assert.equal(
        (
          await db.query(
            'select notifications_enabled from public.teacher_follows',
          )
        ).rows[0].notifications_enabled,
        true,
      );
      await db.query('reset role');
      await db.query(
        `insert into public.push_subscriptions(user_id,endpoint,p256dh,auth,created_at)
      values($1,'https://fcm.googleapis.com/fcm/send/fixture',repeat('a',87),repeat('a',22),now()-interval '1 hour')`,
        [userA],
      );
      await db.query(
        "update public.teacher_follows set created_at=now()-interval '1 hour'",
      );
      await db.query(
        'update public.teacher_poll_state set last_completed_at=now()',
      );
      const poll = async (id: number) =>
        (
          await db.query(
            'select public.record_teacher_shiurim(10,$1,false) as queued',
            [JSON.stringify([{ id, title: 'New shiur' }])],
          )
        ).rows[0].queued;
      assert.equal(await poll(100), 1);
      const createdAt = (
        await db.query('select created_at from public.teacher_follows')
      ).rows[0].created_at;
      await db.query('set local role authenticated');
      await db.query(
        "select public.set_teacher_follow(10,'Teacher',null,true,false)",
      );
      const muted = (
        await db.query(
          'select following,notifications_enabled,created_at from public.teacher_follows',
        )
      ).rows[0];
      assert.equal(muted.following, true);
      assert.equal(muted.notifications_enabled, false);
      assert.deepEqual(muted.created_at, createdAt);
      // The previous client signature preserves an existing mute.
      await db.query(
        "select public.set_teacher_follow(10,'Teacher',null,true)",
      );
      assert.equal(
        (
          await db.query(
            'select notifications_enabled from public.teacher_follows',
          )
        ).rows[0].notifications_enabled,
        false,
      );
      await db.query('reset role');
      assert.equal(
        (
          await db.query(
            'select count(*)::integer as n from public.notification_deliveries',
          )
        ).rows[0].n,
        0,
      );
      assert.equal(await poll(101), 0);
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
        userB,
      ]);
      await db.query('set local role authenticated');
      assert.equal(
        (await db.query('select * from public.teacher_follows')).rowCount,
        0,
      );
      await db.query(
        "select public.set_teacher_follow(10,'Other account',null,true,true)",
      );
      await db.query('reset role');
      assert.equal(
        (
          await db.query(
            'select notifications_enabled from public.teacher_follows where user_id=$1',
            [userA],
          )
        ).rows[0].notifications_enabled,
        false,
      );
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
        userA,
      ]);
      await db.query('set local role authenticated');
      await db.query(
        "select public.set_teacher_follow(10,'Teacher',null,true,true)",
      );
      await db.query('reset role');
      assert.equal(await poll(101), 0, 'Muted upload is never replayed');
      assert.equal(await poll(102), 1, 'New uploads resume after enabling');
      assert.equal(
        (
          await db.query(
            "select has_function_privilege('anon','public.set_teacher_follow(integer,text,text,boolean,boolean)','execute') as allowed",
          )
        ).rows[0].allowed,
        false,
      );
    } finally {
      await db.query('rollback');
      await db.end();
    }
  },
);
