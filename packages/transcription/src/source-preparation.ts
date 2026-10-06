import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { workWake } from './work-wake.js';

export type SourcePreparation = (
  job: { shiur_id: string; transcript_id: string; version: string },
  signal: AbortSignal,
) => Promise<boolean>;

/** A restartable queue separate from publication. Network work owns no SQL client. */
export async function preparePendingSources(
  pool: Pool,
  prepare: SourcePreparation,
  signal: AbortSignal,
) {
  const owner = randomUUID();
  const row = (
    await pool.query<{
      shiur_id: string;
      transcript_id: string;
      version: string;
      created_at: Date;
    }>(
      `WITH candidate AS (
      SELECT shiur_id,version FROM source_preparation_jobs WHERE completed_at IS NULL
      AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE source_preparation_jobs j SET owner=$1,lease_until=now()+interval '6 minutes'
    FROM candidate c WHERE j.shiur_id=c.shiur_id AND j.version=c.version RETURNING j.*`,
      [owner],
    )
  ).rows[0];
  if (!row) return false;
  let ready = false;
  try {
    ready = await prepare(row, signal);
  } catch {
    /* Failed and interrupted attempts remain durable. */
  }
  await pool.query(
    `UPDATE source_preparation_jobs SET completed_at=CASE WHEN $4 THEN now() ELSE NULL END,
    error=CASE WHEN $4 THEN NULL ELSE 'preparation_unavailable' END,
    available_at=now()+LEAST(3600,30*power(2,LEAST(attempt,7)))*interval '1 second',
    attempt=attempt+1,owner=NULL,lease_until=NULL WHERE shiur_id=$1 AND version=$2 AND owner=$3`,
    [row.shiur_id, row.version, owner, ready],
  );
  console.log(
    JSON.stringify({
      event: 'sources_preparation',
      ready,
      lagMs: Date.now() - row.created_at.getTime(),
    }),
  );
  return true;
}

export async function runSourcePreparations(
  pool: Pool,
  prepare: SourcePreparation,
  signal: AbortSignal,
) {
  const wake = workWake(pool);
  // One lane keeps Sefaria load bounded. Leases also deduplicate across hosts.
  while (!signal.aborted) {
    const revision = wake.revision;
    try {
      if (await preparePendingSources(pool, prepare, signal)) continue;
    } catch {
      if (!signal.aborted)
        console.error(JSON.stringify({ event: 'sources_preparation_retry' }));
    }
    try {
      await wake.wait(30000, signal, revision);
    } catch {
      if (!signal.aborted) throw new Error('Preparation wait failed.');
    }
  }
}
