import type { Pool } from 'pg';
import {
  retainPublishedStorage,
  publicationRetentionBacklog,
} from './retention.js';
import { workWake } from './work-wake.js';
import {
  publicationBudget,
  PublicationPausedError,
} from './publication-budget.js';
import {
  runSourcePreparations,
  type SourcePreparation,
} from './source-preparation.js';
import { PublicationValidationError } from './public-content.js';
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
  const budget = publicationBudget(databaseId, env);
  const db = d1HttpDatabase({
    accountId,
    databaseId,
    token,
    beforeRequest: (queries) => budget.reserve(queries),
    onResults: (_queries, metas) => budget.observed(metas),
    onResult: (meta) => {
      budget.observe(meta);
      console.log(
        JSON.stringify({
          event: 'archive_storage_usage',
          rowsRead: meta.rows_read ?? 0,
          rowsWritten: meta.rows_written ?? 0,
          bytes: meta.size_after,
        }),
      );
    },
  });
  return new TranscriptArchive(
    db,
    new D1ContentObjects(db),
    async (statusOnly) => {
      try {
        await budget.check(statusOnly ? 50 : 5000);
      } catch (error) {
        if (
          !(error instanceof PublicationPausedError) ||
          !error.message.includes('storage')
        )
          throw error;
        await db.prepare('SELECT id FROM archive_items LIMIT 0').all();
        await budget.check(statusOnly ? 50 : 5000);
      }
    },
  );
}

/** Hold a per-shiur lock and snapshot while exporting, independently of paid jobs. */
export async function publishPending(
  pool: Pool,
  target: Pick<TranscriptArchive, 'publish'> &
    Partial<
      Pick<
        TranscriptArchive,
        'updateStatus' | 'beforePublication' | 'cleanupIndex'
      >
    >,
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
    let queuedAt: Date | undefined;
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
        await client.query<{
          generation: string;
          content_changed: boolean;
          updated_at: Date;
        }>(
          `SELECT generation,content_changed,updated_at FROM transcript_publications
        WHERE shiur_id=$1 AND generation>published_generation AND available_at<=now()`,
          [id],
        )
      ).rows[0];
      if (!row) {
        await client.query('COMMIT');
        continue;
      }
      generation = Number(row.generation);
      queuedAt = row.updated_at;
      const statusOnly = !row.content_changed && !!target.updateStatus;
      await target.beforePublication?.(statusOnly);
      const status = statusOnly ? await writer.contentStatus(id, client) : null;
      const content = statusOnly
        ? null
        : await writer.publicContent(id, client);
      await client.query('COMMIT');
      if (!content && !status) continue;
      generation = Number(row.generation);
      if (!Number.isSafeInteger(generation))
        throw new Error('Publication generation out of range.');
      // Indexing and hashing run on this Node host. Workers Free permits only
      // 10 ms of CPU per request, so the public Worker performs reads only.
      const result =
        statusOnly && status
          ? await target.updateStatus!({ id, generation, ...status })
          : await target.publish({ generation, content: content! });
      if (!result) {
        await client.query(
          'UPDATE transcript_publications SET content_changed=true WHERE shiur_id=$1 AND generation=$2',
          [id, generation],
        );
        continue;
      }
      if (result.generation < generation)
        throw new Error('Publication failed.');
      await client.query('BEGIN');
      const acknowledged = await client.query(
        `UPDATE transcript_publications SET published_generation=$2,content_changed=false,attempt=0,error=NULL
        WHERE shiur_id=$1 AND generation=$2`,
        [id, generation],
      );
      if (acknowledged.rowCount && !statusOnly && content)
        await client.query(
          `INSERT INTO source_preparation_jobs(shiur_id,version,transcript_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [id, result.version, content.transcriptId],
        );
      await client.query('COMMIT');
      published++;
      console.log(
        JSON.stringify({
          event: 'publication_acknowledged',
          lagMs: queuedAt ? Math.max(0, Date.now() - queuedAt.getTime()) : 0,
        }),
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof PublicationValidationError) {
        await client.query(
          `UPDATE transcript_publications SET error='publication_invalid',available_at='infinity' WHERE shiur_id=$1 AND ($2::bigint IS NULL OR generation=$2)`,
          [id, generation ?? null],
        );
        continue;
      }
      if (error instanceof PublicationPausedError) {
        await client.query(
          `UPDATE transcript_publications SET error='publication_budget',available_at=$3 WHERE shiur_id=$1 AND ($2::bigint IS NULL OR generation=$2)`,
          [id, generation ?? null, error.resumeAt],
        );
        continue;
      }
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
  target: Pick<TranscriptArchive, 'publish'> &
    Partial<
      Pick<
        TranscriptArchive,
        'updateStatus' | 'beforePublication' | 'cleanupIndex'
      >
    >,
  signal: AbortSignal,
  prepare?: SourcePreparation,
) {
  const stop = new AbortController();
  const preparationTask = prepare
    ? runSourcePreparations(
        pool,
        prepare,
        AbortSignal.any([signal, stop.signal]),
      )
    : undefined;
  const wake = workWake(pool);
  let interval = 30000;
  let retained = 0;
  let retentionPending = false;
  try {
    while (!signal.aborted) {
      const observed = wake.revision;
      try {
        const published = await publishPending(pool, target, signal);
        const cleanup = await target.cleanupIndex?.();
        if (cleanup)
          console.log(
            JSON.stringify({ event: 'archive_index_cleanup', ...cleanup }),
          );
        if (Date.now() >= retained) {
          const result = await retainPublishedStorage(pool, true);
          const backlog = await publicationRetentionBacklog(pool);
          retentionPending = backlog.jobs > 0;
          retained = Date.now() + (retentionPending ? 30000 : 24 * 60 * 60_000);
          console.log(
            JSON.stringify({
              event: 'publication_retention',
              ...result,
              pendingJobs: backlog.jobs,
              oldestMs: backlog.oldestMs,
            }),
          );
        }
        interval =
          published || cleanup?.pending || retentionPending
            ? 30000
            : Math.min(15 * 60_000, interval * 2);
        if (published)
          console.log(
            JSON.stringify({
              event: 'transcripts_published',
              count: published,
            }),
          );
      } catch {
        if (!signal.aborted)
          console.error(JSON.stringify({ event: 'publication_retry' }));
      }
      try {
        await wake.wait(interval, signal, observed);
      } catch {
        if (!signal.aborted) throw new Error('Publisher wait failed.');
      }
    }
  } finally {
    stop.abort();
    await preparationTask;
  }
}
