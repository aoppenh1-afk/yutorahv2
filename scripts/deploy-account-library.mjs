import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { notificationCredentials } from './notification-admin.mjs';

// Apply library migrations without redeploying notifications or changing secrets.
const c = await notificationCredentials();
if (!c.projectRef || !c.databasePassword)
  throw new Error('Provide the existing private Supabase credentials file.');
const ca = process.env.SUPABASE_DATABASE_CA_FILE
  ? await readFile(process.env.SUPABASE_DATABASE_CA_FILE, 'utf8')
  : await (
      await fetch(
        'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt',
      )
    ).text();
const host =
  process.env.SUPABASE_DATABASE_HOST || `db.${c.projectRef}.supabase.co`;
const db = new Client({
  host,
  port: 5432,
  user: host.endsWith('.pooler.supabase.com')
    ? `postgres.${c.projectRef}`
    : 'postgres',
  password: c.databasePassword,
  database: 'postgres',
  ssl: { ca, rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});
try {
  await db.connect();
  await db.query('begin');
  await db.query(
    "select pg_advisory_xact_lock(hashtextextended('yutorah-library-migrations',0))",
  );
  for (const name of [
    '202610110008_account_library.sql',
    '202610130009_catalog_follows.sql',
  ]) {
    const sql = await readFile('supabase/migrations/' + name, 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const applied = (
      await db.query(
        'select sha256 from public.notification_migrations where name=$1',
        [name],
      )
    ).rows[0];
    if (applied) {
      if (applied.sha256 !== hash)
        throw new Error('Applied migration changed: ' + name);
      continue;
    }
    await db.query(sql);
    await db.query(
      'insert into public.notification_migrations(name,sha256) values($1,$2)',
      [name, hash],
    );
    console.log('Applied library migration:', name);
  }
  const trigger = await db.query(
    "select tgenabled from pg_trigger where tgrelid='public.library_items'::regclass and tgname='library_follow_validation'",
  );
  if (trigger.rows[0]?.tgenabled !== 'O')
    throw new Error('Follow validation is not enabled.');
  await db.query('commit');
  console.log('Verified private account library follow validation.');
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
