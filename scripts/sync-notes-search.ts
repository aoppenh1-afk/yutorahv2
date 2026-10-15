import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { notesCredential } from '../lib/tidb-notes';
import { TiDBNotesStore } from '../lib/tidb-notes-store';
import { syncNotesPage, cleanNotesIndex } from '../lib/notes-search-index';
import {
  postgresSearchDatabase,
  postgresSearchPool,
} from '../lib/search-postgres';
import { d1HttpDatabase } from '../lib/d1-http';
import { normalize, upstream } from '../lib/yutorah';
import type { RawShiur } from '../lib/api-types';
import { checkSearchSchema } from './check-search-schema';

export async function syncNotesSearch(args = process.argv.slice(2)) {
  const allowed = new Set(['--follow', '--batch']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i]))
      throw new Error('Use --follow or --batch NUMBER.');
    if (args[i] === '--batch') i++;
  }
  const position = args.indexOf('--batch');
  const batch = position >= 0 ? Number(args[position + 1]) : 10;
  if (!Number.isInteger(batch) || batch < 1 || batch > 20)
    throw new RangeError('Choose --batch between 1 and 20.');
  const credential = notesCredential();
  if (!credential)
    throw new Error('Configure the read-only TIDB_NOTES_* connection.');
  // Index writes belong to an operator connection, never the public website role.
  const connection =
    process.env.NOTES_SEARCH_DATABASE_URL ||
    process.env.SEARCH_MIGRATION_DATABASE_URL;
  if (!connection && process.env.SEARCH_DATABASE_URL)
    throw new Error(
      'Set NOTES_SEARCH_DATABASE_URL to the notes-index writer connection.',
    );
  const pool = connection ? postgresSearchPool(connection) : null;
  const db = pool
    ? postgresSearchDatabase(pool)
    : d1HttpDatabase({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
        databaseId: process.env.SEARCH_D1_DATABASE_ID || '',
        token: process.env.SEARCH_D1_API_TOKEN || '',
      });
  const source = new TiDBNotesStore(credential);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await checkSearchSchema(db);
    do {
      try {
        let complete = false;
        while (!complete && !abort.signal.aborted) {
          const progress = await syncNotesPage(
            db,
            source,
            async (id) => {
              const raw = await upstream<RawShiur>(
                'shiur/details?shiurID=' + id,
                600,
              );
              const shiur = normalize(raw);
              if (shiur.id !== Number(id))
                throw new Error('The shiur metadata could not be verified.');
              return shiur;
            },
            { batch },
          );
          console.log(
            JSON.stringify({ event: 'notes_search_sync', ...progress }),
          );
          complete = progress.complete;
          if (progress.busy)
            await delay(1000, undefined, { signal: abort.signal });
        }
        if (complete) {
          for (let sweep = 0; sweep < 100 && !abort.signal.aborted; sweep++)
            if (!(await cleanNotesIndex(db)).meta.changes) break;
        }
      } catch (error) {
        if (abort.signal.aborted) break;
        if (!args.includes('--follow')) throw error;
        console.error(
          JSON.stringify({
            event: 'notes_search_sync_failed',
            retryInSeconds: 900,
          }),
        );
      }
      if (!args.includes('--follow') || abort.signal.aborted) break;
      await delay(900_000, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await pool?.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  syncNotesSearch().catch((error) => {
    // Driver errors can contain connection information; keep logs credential-free.
    console.error(
      error instanceof RangeError
        ? error.message
        : 'Notes indexing failed. Check its source connection, writer grants, and schema migrations; rerun to resume.',
    );
    process.exitCode = 1;
  });
}
