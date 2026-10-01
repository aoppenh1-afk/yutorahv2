import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
export function searchDatabase(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error('Search storage is unavailable.');
  return db;
}
