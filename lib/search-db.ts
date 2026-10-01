import { env } from 'cloudflare:workers';
import type { SearchDatabase } from './search-storage';
export function searchDatabase(): SearchDatabase {
  const db = (env as unknown as { DB?: SearchDatabase }).DB;
  if (!db) throw new Error('Search storage is unavailable.');
  return db;
}
