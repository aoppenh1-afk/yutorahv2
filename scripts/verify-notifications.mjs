import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { notificationCredentials } from './notification-admin.mjs';

// Live integration checks use disposable users and remove every fixture.
const c = await notificationCredentials();
if (!c.projectUrl || !c.serviceRoleKey || !c.anonKey)
  throw new Error('Provide private notification credentials.');
const admin = createClient(c.projectUrl, c.serviceRoleKey, {
  auth: { persistSession: false },
});
const anonymous = createClient(c.projectUrl, c.anonKey, {
  auth: { persistSession: false },
});
const users = [];
const teacherId = 2147480001;
const check = async (promise) => {
  const r = await promise;
  if (r.error) throw new Error(r.error.message);
  return r.data;
};
async function fixtureUser() {
  const email = 'notification-test-' + crypto.randomUUID() + '@example.invalid';
  const password = crypto.randomUUID() + crypto.randomUUID();
  const { user } = await check(
    admin.auth.admin.createUser({ email, password, email_confirm: true }),
  );
  users.push(user.id);
  const client = createClient(c.projectUrl, c.anonKey, {
    auth: { persistSession: false },
  });
  await check(client.auth.signInWithPassword({ email, password }));
  return { client, id: user.id };
}
const follow = (client, following = true) =>
  check(
    client.rpc('set_teacher_follow', {
      p_teacher_id: teacherId,
      p_teacher_name: 'Disposable notification fixture',
      p_image: null,
      p_following: following,
    }),
  );
try {
  const a = await fixtureUser();
  const b = await fixtureUser();
  await follow(a.client);
  assert.equal(
    (await check(b.client.from('teacher_follows').select('*'))).length,
    0,
    'Other users cannot read follows',
  );
  assert.ok(
    (
      await anonymous.rpc('set_teacher_follow', {
        p_teacher_id: teacherId,
        p_teacher_name: 'Unauthorized',
        p_image: null,
        p_following: true,
      })
    ).error,
    'Anonymous cannot follow',
  );
  assert.ok(
    (
      await a.client.rpc('claim_notification_worker', {
        p_token: crypto.randomUUID(),
      })
    ).error,
    'Authenticated users cannot run the worker',
  );
  assert.ok(
    (
      await a.client
        .from('teacher_follows')
        .update({ user_id: b.id })
        .eq('teacher_id', teacherId)
    ).error,
    'Clients cannot bypass the follow RPC',
  );
  const endpoint =
    'https://fcm.googleapis.com/fcm/send/notification-test-' +
    crypto.randomUUID();
  const p256dh = Buffer.alloc(65, 1).toString('base64url');
  const auth = Buffer.alloc(16, 2).toString('base64url');
  const subscriptionId = await check(
    a.client.rpc('register_push_subscription', {
      p_endpoint: endpoint,
      p_p256dh: p256dh,
      p_auth: auth,
      p_device_name: 'Disposable fixture',
    }),
  );
  assert.equal(
    (await check(b.client.from('push_subscriptions').select('*'))).length,
    0,
    'Device endpoints are private',
  );
  assert.ok(
    (
      await b.client.rpc('queue_test_notification', {
        p_subscription_id: subscriptionId,
      })
    ).error,
    'Other users cannot send a test to this device',
  );
  assert.ok(
    (
      await a.client.rpc('register_push_subscription', {
        p_endpoint: 'https://127.0.0.1/internal',
        p_p256dh: p256dh,
        p_auth: auth,
        p_device_name: 'Invalid',
      })
    ).error,
    'Arbitrary endpoints are rejected',
  );
  await check(
    admin
      .from('teacher_poll_state')
      .update({ cycle_started_at: new Date().toISOString() })
      .eq('teacher_id', teacherId),
  );
  assert.equal(
    await check(
      admin.rpc('record_teacher_shiurim', {
        p_teacher_id: teacherId,
        p_items: [{ id: 42, title: 'Old recording' }],
        p_baseline: true,
      }),
    ),
    0,
    'Baseline is silent',
  );
  await check(
    admin
      .from('teacher_poll_state')
      .update({ last_completed_at: new Date().toISOString() })
      .eq('teacher_id', teacherId),
  );
  assert.equal(
    await check(
      admin.rpc('record_teacher_shiurim', {
        p_teacher_id: teacherId,
        p_items: [{ id: 43, title: 'Backdated new upload' }],
        p_baseline: false,
      }),
    ),
    1,
    'A new ID queues one notification',
  );
  assert.equal(
    await check(
      admin.rpc('record_teacher_shiurim', {
        p_teacher_id: teacherId,
        p_items: [{ id: 43, title: 'Backdated new upload' }],
        p_baseline: false,
      }),
    ),
    0,
    'Repeating a poll cannot duplicate delivery',
  );
  await follow(a.client, false);
  assert.equal(
    (
      await check(
        admin
          .from('notification_deliveries')
          .select('id')
          .eq('subscription_id', subscriptionId),
      )
    ).length,
    0,
    'Unfollowing clears pending alerts before a possible refollow',
  );
  assert.equal(
    await check(
      admin.rpc('record_teacher_shiurim', {
        p_teacher_id: teacherId,
        p_items: [{ id: 44, title: 'After unfollow' }],
        p_baseline: false,
      }),
    ),
    0,
    'Unfollow prevents new notifications',
  );
  await check(
    a.client.rpc('remove_push_subscription', { p_endpoint: endpoint }),
  );
  assert.equal(
    (
      await check(
        admin
          .from('notification_deliveries')
          .select('id')
          .eq('subscription_id', subscriptionId),
      )
    ).length,
    0,
    'Removing a device clears pending deliveries',
  );
  await follow(a.client);
  await check(
    b.client.rpc('set_teacher_follow', {
      p_teacher_id: teacherId,
      p_teacher_name: 'Other account label',
      p_image: null,
      p_following: true,
    }),
  );
  const devices = await Promise.all(
    [a, b].map((account, i) =>
      check(
        account.client.rpc('register_push_subscription', {
          p_endpoint: endpoint + '-' + i,
          p_p256dh: p256dh,
          p_auth: auth,
          p_device_name: 'Label fixture',
        }),
      ),
    ),
  );
  await check(
    admin
      .from('teacher_poll_state')
      .update({ cycle_started_at: new Date().toISOString() })
      .eq('teacher_id', teacherId),
  );
  assert.equal(
    await check(
      admin.rpc('record_teacher_shiurim', {
        p_teacher_id: teacherId,
        p_items: [{ id: 45, title: 'Catch-up before new devices' }],
        p_baseline: false,
      }),
    ),
    0,
    'New follows and devices do not receive an old teacher’s catch-up uploads',
  );
  await check(
    admin
      .from('teacher_poll_state')
      .update({ last_completed_at: new Date().toISOString() })
      .eq('teacher_id', teacherId),
  );
  assert.equal(
    await check(
      admin.rpc('record_teacher_shiurim', {
        p_teacher_id: teacherId,
        p_items: [{ id: 46, title: 'Per-account labels' }],
        p_baseline: false,
      }),
    ),
    2,
  );
  const labels = await check(
    admin
      .from('notification_deliveries')
      .select('subscription_id,payload')
      .eq('shiur_id', 46)
      .eq('teacher_id', teacherId),
  );
  assert.equal(
    labels.find((row) => row.subscription_id === devices[0])?.payload.title,
    'Disposable notification fixture posted a shiur',
  );
  assert.equal(
    labels.find((row) => row.subscription_id === devices[1])?.payload.title,
    'Other account label posted a shiur',
    'One account cannot change another account’s notification label',
  );
  const noAuth = await fetch(c.projectUrl + '/functions/v1/notify-shiurim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(
    noAuth.status,
    401,
    'The worker rejects unauthenticated invocation',
  );
  console.log(
    'Live checks passed: account isolation, private devices, endpoint validation, silent baseline, upload deduplication, unfollow, device cleanup, worker authentication.',
  );
} finally {
  for (const id of users) await check(admin.auth.admin.deleteUser(id));
  await check(
    admin.from('teacher_poll_state').delete().eq('teacher_id', teacherId),
  );
  console.log(
    'Removed disposable integration users and notification fixtures.',
  );
}
