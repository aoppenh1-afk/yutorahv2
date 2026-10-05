import type { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { TranscriptionStore } from './store.js';
import { TranscriptArchive } from './archive.js';
import { D1ContentObjects } from './d1-content.js';
import { d1HttpDatabase } from '../../../lib/d1-http.js';

export function publicationTarget(
  env: Record<string, string | undefined> = process.env,
): TranscriptArchive | undefined {
  const {
    TRANSCRIPT_ARCHIVE_ACCOUNT_ID: accountId,
    TRANSCRIPT_ARCHIVE_DATABASE_ID: databaseId,
    TRANSCRIPT_ARCHIVE_API_TOKEN: token,
  } = env;
  if (!accountId && !databaseId && !token) return undefined;
  if (!accountId || !databaseId || !token)
    throw new Error('Invalid transcript publication configuration.');
  const db = d1HttpDatabase({ accountId, databaseId, token });
  return new TranscriptArchive(db, new D1ContentObjects(db));
}

/** Hold a per-shiur lock and snapshot while exporting, independently of paid jobs. */
export async function publishPending(
  pool: Pool,
  target: Pick<TranscriptArchive, 'publish'>,
  signal: AbortSignal,
  limit = 20,
) {
  const writer = new TranscriptionStore(pool);
  let published = 0;
  const rows = await pool.query<{ shiur_id: string }>(
    `SELECT shiur_id FROM transcript_publications
    WHERE generation>published_generation AND available_at<=now() ORDER BY available_at LIMIT $1`,
    [limit],
  );
  for (const { shiur_id: id } of rows.rows) {
    signal.throwIfAborted();
    const client = await pool.connect();
    let locked = false;
    let generation: number | undefined;
    try {
      locked = (
        await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(891734,hashtext($1)) AS locked',
          [id],
        )
      ).rows[0].locked;
      if (!locked) continue;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const row = (
        await client.query<{ generation: string }>(
          `SELECT generation FROM transcript_publications
        WHERE shiur_id=$1 AND generation>published_generation AND available_at<=now()`,
          [id],
        )
      ).rows[0];
      if (!row) {
        await client.query('COMMIT');
        continue;
      }
      const content = await writer.publicContent(id, client);
      await client.query('COMMIT');
      if (!content) continue;
      generation = Number(row.generation);
      if (!Number.isSafeInteger(generation))
        throw new Error('Publication generation out of range.');
      // Indexing and hashing run on this Node host. Workers Free permits only
      // 10 ms of CPU per request, so the public Worker performs reads only.
      const result = await target.publish({ generation, content });
      if (result.generation < generation)
        throw new Error('Publication failed.');
      await client.query(
        `UPDATE transcript_publications SET published_generation=$2,attempt=0,error=NULL
        WHERE shiur_id=$1 AND generation=$2`,
        [id, generation],
      );
      published++;
    } catch {
      await client.query('ROLLBACK').catch(() => {});
      if (signal.aborted) signal.throwIfAborted();
      await client.query(
        `UPDATE transcript_publications SET attempt=attempt+1,error='publication_failed',
        available_at=now()+LEAST(3600,30*power(2,LEAST(attempt,7))) * interval '1 second'
        WHERE shiur_id=$1 AND ($2::bigint IS NULL OR generation=$2)`,
        [id, generation ?? null],
      );
    } finally {
      if (locked)
        await client
          .query('SELECT pg_advisory_unlock(891734,hashtext($1))', [id])
          .catch(() => {});
      client.release();
    }
  }
  return published;
}
export async function runPublisher(
  pool: Pool,
  target: Pick<TranscriptArchive, 'publish'>,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      const published = await publishPending(pool, target, signal);
      if (published)
        console.log(
          JSON.stringify({ event: 'transcripts_published', count: published }),
        );
    } catch {
      if (!signal.aborted)
        console.error(JSON.stringify({ event: 'publication_retry' }));
    }
    try {
      await delay(30_000, undefined, { signal });
    } catch {
      if (!signal.aborted) throw new Error('Publisher wait failed.');
    }
  }
}
