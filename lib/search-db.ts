import { env } from 'cloudflare:workers';
export function searchDatabase(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error('Search storage is unavailable.');
  return db;
}
