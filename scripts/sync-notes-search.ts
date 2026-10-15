import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
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

export function notesSyncOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      follow: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      batch: { type: 'string', default: '10' },
      'max-pages': { type: 'string', default: '1000' },
      'max-minutes': { type: 'string', default: '20' },
    },
  });
  const batch = Number(values.batch);
  const maxPages = Number(values['max-pages']);
  const maxMinutes = Number(values['max-minutes']);
  if (!Number.isInteger(batch) || batch < 1 || batch > 20)
    throw new RangeError('Choose --batch between 1 and 20.');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000)
    throw new RangeError('Choose --max-pages between 1 and 1000.');
  if (!Number.isFinite(maxMinutes) || maxMinutes < 1 || maxMinutes > 20)
    throw new RangeError('Choose --max-minutes between 1 and 20.');
  return {
    batch,
    maxPages,
    maxMinutes,
    follow: values.follow,
    check: values.check,
  };
}

export async function syncNotesSearch(args = process.argv.slice(2)) {
  const options = notesSyncOptions(args);
  const { batch } = options;
  const databaseBudget = Number(
    process.env.NOTES_SEARCH_MAX_DATABASE_BYTES || 0,
  );
  if (!Number.isSafeInteger(databaseBudget) || databaseBudget < 0)
    throw new RangeError('Use a nonnegative NOTES_SEARCH_MAX_DATABASE_BYTES.');
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
    if (options.check) {
      await source.headersAfter(0, 1);
      console.log(
        'Notes search schema and read-only source connection verified.',
      );
      return;
    }
    do {
      const deadline = Date.now() + options.maxMinutes * 60_000;
      let pages = 0;
      try {
        let complete = false;
        while (
          !complete &&
          !abort.signal.aborted &&
          pages < options.maxPages &&
          Date.now() < deadline
        ) {
          pages++;
          if (pool && databaseBudget) {
            const size = Number(
              (
                await pool.query(
                  'SELECT pg_database_size(current_database()) AS bytes',
                )
              ).rows[0].bytes,
            );
            if (size >= databaseBudget)
              throw new RangeError(
                'Notes indexing reached its database storage checkpoint; increase allocated capacity before resuming.',
              );
          }
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
        if (!complete && !abort.signal.aborted)
          console.log(
            JSON.stringify({ event: 'notes_search_checkpoint', pages }),
          );
        if (complete) {
          for (let sweep = 0; sweep < 100 && !abort.signal.aborted; sweep++)
            if (!(await cleanNotesIndex(db)).meta.changes) break;
        }
      } catch (error) {
        if (abort.signal.aborted) break;
        if (!options.follow) throw error;
        console.error(
          JSON.stringify({
            event: 'notes_search_sync_failed',
            retryInSeconds: 900,
          }),
        );
      }
      if (!options.follow || abort.signal.aborted) break;
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
