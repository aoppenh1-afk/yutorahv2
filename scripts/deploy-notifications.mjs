import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { notificationAdmin, sqlLiteral } from './notification-admin.mjs';

const { credentials: c, request, query } = await notificationAdmin();
if (!c.vapidPublicKey || !c.vapidPrivateKey || !c.cronSecret || !c.projectUrl)
  throw new Error(
    'Missing push keys or scheduler secret in the private credentials file. Generate and save them once; do not rotate existing keys during deployment.',
  );
await query(
  `create table if not exists public.notification_migrations(name text primary key,sha256 text not null,applied_at timestamptz not null default now());alter table public.notification_migrations enable row level security;revoke all on public.notification_migrations from anon,authenticated;`,
);
const applied = new Map(
  (await query('select name,sha256 from public.notification_migrations')).map(
    (r) => [r.name, r.sha256],
  ),
);
await request('/secrets', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([
    { name: 'VAPID_PUBLIC_KEY', value: c.vapidPublicKey },
    { name: 'VAPID_PRIVATE_KEY', value: c.vapidPrivateKey },
    { name: 'NOTIFICATION_CRON_SECRET', value: c.cronSecret },
  ]),
});
for (const [name, value] of [
  ['notification_project_url', c.projectUrl],
  ['notification_cron_secret', c.cronSecret],
]) {
  await query(
    `do $$ declare existing uuid; begin select id into existing from vault.secrets where name=${sqlLiteral(name)}; if existing is null then perform vault.create_secret(${sqlLiteral(value)},${sqlLiteral(name)});else perform vault.update_secret(existing,${sqlLiteral(value)});end if;end $$;`,
  );
}
// Functions are bundled server-side from these exact tracked sources.
const form = new FormData();
for (const name of ['index.ts', 'core.ts'])
  form.append(
    'file',
    new Blob([await readFile('supabase/functions/notify-shiurim/' + name)], {
      type: 'application/typescript',
    }),
    name,
  );
form.append(
  'metadata',
  JSON.stringify({
    name: 'notify-shiurim',
    entrypoint_path: 'index.ts',
    verify_jwt: false,
  }),
);
const result = await request('/functions/deploy?slug=notify-shiurim', {
  method: 'POST',
  body: form,
});
console.log(
  'Notification function deployed:',
  result.status,
  'version',
  result.version,
);
for (const name of (await readdir('supabase/migrations'))
  .filter((n) => n.endsWith('.sql'))
  .sort()) {
  const sql = await readFile('supabase/migrations/' + name, 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  if (applied.has(name)) {
    if (applied.get(name) !== hash)
      throw new Error('Applied migration changed: ' + name);
    continue;
  }
  await query(
    'begin;\n' +
      sql +
      '\ninsert into public.notification_migrations(name,sha256) values(' +
      sqlLiteral(name) +
      ',' +
      sqlLiteral(hash) +
      ');commit;',
  );
  console.log('Applied migration:', name);
}
const googlePath = process.env.GOOGLE_OAUTH_CREDENTIALS_FILE;
const google = googlePath
  ? JSON.parse(await readFile(googlePath, 'utf8')).web
  : null;
if (googlePath && (!google?.client_id || !google?.client_secret))
  throw new Error(
    'Google credentials must be a Web application OAuth JSON file.',
  );
await request('/config/auth', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    site_url: 'https://yutorah.vercel.app',
    uri_allow_list:
      'https://yutorah.vercel.app/auth/callback,http://localhost:5173/auth/callback,http://localhost:3000/auth/callback',
    ...(google
      ? {
          external_google_enabled: true,
          external_google_client_id: google.client_id,
          external_google_secret: google.client_secret,
        }
      : {}),
  }),
});
const schedules = await query(
  "select jobname,schedule,active from cron.job where jobname='yutorah-notifications-every-six-hours'",
);
console.log('Verified scheduler:', JSON.stringify(schedules));
console.log(
  'Cloudflare services created: none. Supabase billing plan is unchanged.',
);
