import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import webpush from 'npm:web-push@3.6.7';
import { XMLParser } from 'npm:fast-xml-parser@5.11.2';
import {
  catalogItems,
  rssItems,
  validPushEndpoint,
  deliveryFailure,
} from './core.ts';

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error('Missing ' + name);
  return value;
};
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const parser = new XMLParser({
  processEntities: false,
  ignoreAttributes: true,
});
webpush.setVapidDetails(
  'https://yutorah.vercel.app',
  env('VAPID_PUBLIC_KEY'),
  env('VAPID_PRIVATE_KEY'),
);
const origins = new Set([
  'https://yutorah.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
]);

async function rpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}
async function upstream(url: string) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json, application/xml, text/xml' },
  });
  if (!r.ok) throw new Error('YUTorah HTTP ' + r.status);
  return r;
}
async function deliver(deadline: number, limit = 100, subscriptionId?: string) {
  let query = db
    .from('notification_deliveries')
    .select('*,push_subscriptions!inner(*)')
    .is('sent_at', null)
    .lte('next_attempt_at', new Date().toISOString())
    .lt('attempts', 5)
    .order('id')
    .limit(limit);
  if (subscriptionId) query = query.eq('subscription_id', subscriptionId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  let sent = 0;
  for (const row of data ?? []) {
    if (Date.now() > deadline) break;
    const s = row.push_subscriptions;
    if (row.teacher_id !== 0) {
      const { data: follow, error: followError } = await db
        .from('teacher_follows')
        .select('following')
        .eq('user_id', s.user_id)
        .eq('teacher_id', row.teacher_id)
        .maybeSingle();
      if (followError) throw new Error(followError.message);
      if (!follow?.following) {
        await db.from('notification_deliveries').delete().eq('id', row.id);
        continue;
      }
    }
    try {
      if (!validPushEndpoint(s.endpoint))
        throw Object.assign(new Error('Invalid endpoint'), { statusCode: 400 });
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(row.payload),
        { TTL: 86400, timeout: 8000, urgency: 'normal' },
      );
      const { error: updateError } = await db
        .from('notification_deliveries')
        .update({
          sent_at: new Date().toISOString(),
          attempts: row.attempts + 1,
        })
        .eq('id', row.id);
      if (updateError) throw new Error(updateError.message);
      sent++;
    } catch (e) {
      const policy = deliveryFailure(
        (e as { statusCode?: number }).statusCode,
        row.attempts + 1,
      );
      if (policy.remove)
        await db.from('push_subscriptions').delete().eq('id', s.id);
      else
        await db
          .from('notification_deliveries')
          .update({
            attempts: policy.abandon ? 5 : row.attempts + 1,
            next_attempt_at: new Date(
              Date.now() + policy.delayMs,
            ).toISOString(),
          })
          .eq('id', row.id);
    }
  }
  return sent;
}

async function runWorker() {
  const token = crypto.randomUUID();
  if (!(await rpc('claim_notification_worker', { p_token: token })))
    return { busy: true };
  const deadline = Date.now() + 75_000;
  let pages = 0,
    queued = 0,
    sent = 0,
    failed = 0,
    more = false;
  try {
    sent += await deliver(deadline);
    while (Date.now() < deadline && pages < 25) {
      const [state] = await rpc('next_teacher_poll');
      if (!state) break;
      const baseline = !state.initialized_at;
      try {
        if (state.next_page === 1) {
          // RSS is in upload order. Full catalog scans also find backdated
          // recordings and videos omitted from the audio RSS feed.
          try {
            const xml = await (
              await upstream(
                'https://www.yutorah.org/rss/RecentAudioShiurim?teacherID=' +
                  state.teacher_id +
                  '&numberOfRssResults=50',
              )
            ).text();
            if (xml.length > 1_000_000)
              throw new Error('Upload feed too large');
            queued += await rpc('record_teacher_shiurim', {
              p_teacher_id: state.teacher_id,
              p_items: rssItems(parser.parse(xml)),
              p_baseline: baseline,
            });
          } catch {
            /* The complete catalog scan remains authoritative. */
          }
        }
        const response = await upstream(
          'https://api.yutorah.org/search/get?searchTerm=&getFacets=false&teacherID=' +
            state.teacher_id +
            '&start=' +
            state.next_page,
        );
        const { items, total } = catalogItems(await response.json());
        if (!items.length && total > 0)
          throw new Error('Unexpected empty catalog page');
        queued += await rpc('record_teacher_shiurim', {
          p_teacher_id: state.teacher_id,
          p_items: items,
          p_baseline: baseline,
        });
        const complete = total === 0 || state.next_page * 30 >= total;
        const now = new Date().toISOString();
        const { error } = await db
          .from('teacher_poll_state')
          .update(
            complete
              ? {
                  next_page: 1,
                  cycle_started_at: null,
                  last_completed_at: now,
                  initialized_at: state.initialized_at ?? now,
                  retry_at: null,
                  last_error: null,
                }
              : {
                  next_page: state.next_page + 1,
                  retry_at: null,
                  last_error: null,
                },
          )
          .eq('teacher_id', state.teacher_id);
        if (error) throw new Error(error.message);
        pages++;
      } catch (e) {
        failed++;
        await db
          .from('teacher_poll_state')
          .update({
            retry_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
            last_error: (e instanceof Error
              ? e.message
              : 'Polling failed'
            ).slice(0, 200),
          })
          .eq('teacher_id', state.teacher_id);
      }
    }
    if (Date.now() < deadline) sent += await deliver(deadline);
    // Queue a bounded continuation for unfinished catalogs and large fan-outs.
    const [next] = await rpc('next_teacher_poll');
    const { count } = await db
      .from('notification_deliveries')
      .select('id', { count: 'exact', head: true })
      .is('sent_at', null)
      .lt('attempts', 5)
      .lte('next_attempt_at', new Date().toISOString());
    more = !!next || !!count;
    await db
      .from('notification_deliveries')
      .delete()
      .lt('created_at', new Date(Date.now() - 30 * 86400000).toISOString());
    return { pages, queued, sent, failed, more };
  } finally {
    await db
      .from('notification_worker')
      .update({
        lease_until: null,
        lease_token: null,
        last_finished_at: new Date().toISOString(),
        last_result: { pages, queued, sent, failed, more },
      })
      .eq('singleton', true)
      .eq('lease_token', token);
    if (more) await rpc('dispatch_notification_worker');
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') ?? '';
  const cors: Record<string, string> = origins.has(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Allow-Headers':
          'authorization, apikey, content-type, x-client-info',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }
    : {};
  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: origins.has(origin) ? 204 : 403,
      headers: cors,
    });
  if (request.method !== 'POST')
    return Response.json({ error: 'Use POST' }, { status: 405, headers: cors });
  try {
    if (
      request.headers.get('x-cron-secret') === env('NOTIFICATION_CRON_SECRET')
    )
      return Response.json(await runWorker());
    const auth = request.headers.get('authorization') ?? '';
    const {
      data: { user },
      error,
    } = await db.auth.getUser(auth.replace(/^Bearer /i, ''));
    if (error || !user)
      return Response.json(
        { error: 'Sign in first' },
        { status: 401, headers: cors },
      );
    if (
      request.headers.get('content-length') &&
      Number(request.headers.get('content-length')) > 4096
    )
      return Response.json(
        { error: 'Request too large' },
        { status: 413, headers: cors },
      );
    const { subscriptionId } = await request.json();
    if (
      typeof subscriptionId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(subscriptionId)
    )
      return Response.json(
        { error: 'Choose a device' },
        { status: 400, headers: cors },
      );
    // Queue with the user's JWT so the database checks ownership and rate limits.
    const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    });
    const { error: queueError } = await client.rpc('queue_test_notification', {
      p_subscription_id: subscriptionId,
    });
    if (queueError)
      return Response.json(
        { error: queueError.message },
        { status: 400, headers: cors },
      );
    const sent = await deliver(Date.now() + 12000, 1, subscriptionId);
    return Response.json({ sent }, { headers: cors });
  } catch (e) {
    console.error(
      'Notification worker failed',
      e instanceof Error ? e.message : 'Unknown error',
    );
    return Response.json(
      { error: 'Notifications could not be checked. Please try again.' },
      { status: 500, headers: cors },
    );
  }
});
