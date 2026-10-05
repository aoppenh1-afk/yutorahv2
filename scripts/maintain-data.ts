import { Pool } from 'pg';
import { mkdir, open, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { retainPublishedStorage } from '../packages/transcription/src/retention';
import { postgresSearchDatabase } from '../lib/search-postgres';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const backupIndex = args.indexOf('--backup-dir');
const backupPath = backupIndex < 0 ? undefined : args[backupIndex + 1];
const backupDir =
  backupPath && !backupPath.startsWith('--') ? resolve(backupPath) : undefined;
if (args.includes('--help')) {
  console.log(
    'tsx scripts/maintain-data.ts [--apply] [--prune-inactive --backup-dir PRIVATE_DIRECTORY]\nDry run by default. SEARCH_DATABASE_URL cleans disposable caches. TRANSCRIPTION_DATABASE_URL cleans acknowledged completed checkpoints/notes. Inactive transcripts require verified backups and --prune-inactive.',
  );
  process.exit(0);
}
if (args.includes('--prune-inactive') && !backupDir)
  throw new Error('Inactive transcript cleanup requires --backup-dir.');
if (!process.env.SEARCH_DATABASE_URL && !process.env.TRANSCRIPTION_DATABASE_URL)
  throw new Error('Configure a maintenance database connection.');
if (process.env.SEARCH_DATABASE_URL) {
  const pool = new Pool({
    connectionString: process.env.SEARCH_DATABASE_URL,
    max: 1,
  });
  try {
    const db = postgresSearchDatabase(pool);
    const expired = `created<$1 AND ((next-1)*30>=total OR created<$2) AND fingerprint NOT LIKE 'trending:v1:%'`;
    const params = [Date.now() - 3600000, Date.now() - 86400000];
    const runs = await pool.query(
      `SELECT count(*) AS runs FROM yutorah_search.search_runs WHERE ${expired}`,
      params,
    );
    const docs = await pool.query(
      `SELECT count(*) AS documents,COALESCE(SUM(octet_length(payload)),0) AS bytes FROM yutorah_search.search_documents d WHERE NOT EXISTS(SELECT 1 FROM yutorah_search.search_hits h WHERE h.document_key=d.key)`,
    );
    console.log(
      JSON.stringify({
        storage: 'search',
        applied: apply,
        ...runs.rows[0],
        ...docs.rows[0],
      }),
    );
    if (apply) {
      // Bound each transaction; repeated executions also clear a large old cache.
      await db
        .prepare(
          `DELETE FROM search_runs WHERE id IN(SELECT id FROM search_runs WHERE created<? AND ((next-1)*30>=total OR created<?) AND fingerprint NOT LIKE 'trending:v1:%' LIMIT 100)`,
        )
        .bind(...params)
        .run();
      await db
        .prepare(
          'DELETE FROM search_documents WHERE key IN(SELECT key FROM search_documents d WHERE NOT EXISTS(SELECT 1 FROM search_hits h WHERE h.document_key=d.key) LIMIT 5000)',
        )
        .run();
      await pool.query(
        'DELETE FROM yutorah_search.search_creation_leases WHERE expires<$1',
        [Date.now()],
      );
      await pool.query(
        'DELETE FROM yutorah_search.sources_runs WHERE id IN(SELECT id FROM yutorah_search.sources_runs WHERE lease<$1 AND (expires<$1 OR id LIKE $2) LIMIT 1000)',
        [Date.now(), 'input:v1:%'],
      );
    }
  } finally {
    await pool.end();
  }
}
if (process.env.TRANSCRIPTION_DATABASE_URL) {
  const pool = new Pool({
    connectionString: process.env.TRANSCRIPTION_DATABASE_URL,
    max: 1,
  });
  try {
    console.log(
      JSON.stringify({
        storage: 'transcription',
        ...(await retainPublishedStorage(pool, apply, 1000)),
      }),
    );
    if (args.includes('--archive-only-search')) {
      if (
        process.env.TRANSCRIPT_ARCHIVE_ONLY_SEARCH !== 'true' ||
        !process.env.TRANSCRIPT_ARCHIVE_URL
      )
        throw new Error(
          'Configure the archive reader and enable TRANSCRIPT_ARCHIVE_ONLY_SEARCH before removing database search indexes.',
        );
      const pending = await pool.query(
        `SELECT COUNT(*) AS count FROM transcription_shiurim h LEFT JOIN transcript_publications p ON p.shiur_id=h.id WHERE h.active_transcript_id IS NOT NULL AND (p.shiur_id IS NULL OR p.generation<>p.published_generation OR p.content_changed)`,
      );
      if (Number(pending.rows[0].count))
        throw new Error('Publish every active transcript first.');
      console.log(JSON.stringify({ archiveOnlySearch: true, applied: apply }));
      if (apply)
        await pool.query(
          await readFile(
            'db/transcription-options/archive_only_search.sql',
            'utf8',
          ),
        );
    }
    if (args.includes('--prune-inactive')) {
      const eligible = `SELECT t.id FROM transcripts t JOIN transcription_jobs j ON j.id=t.job_id
        JOIN transcription_shiurim h ON h.id=t.shiur_id JOIN transcript_publications p ON p.shiur_id=h.id
        WHERE t.id IS DISTINCT FROM h.active_transcript_id AND j.id IS DISTINCT FROM h.latest_job_id
        AND j.status='completed' AND j.completed_at<now()-interval '90 days'
        AND p.generation=p.published_generation AND NOT p.content_changed ORDER BY t.id LIMIT 100`;
      const rows = (await pool.query<{ id: string }>(eligible)).rows;
      console.log(
        JSON.stringify({ inactiveVersions: rows.length, applied: apply }),
      );
      if (apply) {
        await mkdir(backupDir!, { recursive: true, mode: 0o700 });
        for (const { id } of rows) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const transcript = (
              await client.query(
                'SELECT * FROM transcripts WHERE id=$1 FOR UPDATE',
                [id],
              )
            ).rows[0];
            await client.query(
              'SELECT id FROM transcription_shiurim WHERE id=$1 FOR UPDATE',
              [transcript.shiur_id],
            );
            const segments = (
              await client.query(
                'SELECT * FROM transcript_segments WHERE transcript_id=$1 ORDER BY segment_index FOR UPDATE',
                [id],
              )
            ).rows;
            const jobs = (
              await client.query(
                'SELECT * FROM notes_jobs WHERE transcript_id=$1 FOR UPDATE',
                [id],
              )
            ).rows;
            const notes = (
              await client.query(
                'SELECT * FROM transcript_notes WHERE transcript_id=$1 FOR UPDATE',
                [id],
              )
            ).rows;
            const original = JSON.stringify({
              transcript,
              segments,
              jobs,
              notes,
            });
            const file = join(backupDir!, id + '.json.gz');
            try {
              const handle = await open(file, 'wx', 0o600);
              try {
                await handle.writeFile(gzipSync(original));
                await handle.sync();
              } finally {
                await handle.close();
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
            }
            if (gunzipSync(await readFile(file)).toString() !== original)
              throw new Error('Backup verification failed.');
            const directory = await open(backupDir!, 'r');
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
            const deleted = await client.query(
              `DELETE FROM transcripts t USING transcription_jobs j,transcription_shiurim h,transcript_publications p
              WHERE t.id=$1 AND j.id=t.job_id AND h.id=t.shiur_id AND p.shiur_id=h.id
              AND t.id IS DISTINCT FROM h.active_transcript_id AND j.id IS DISTINCT FROM h.latest_job_id
              AND j.status='completed' AND p.generation=p.published_generation AND NOT p.content_changed`,
              [id],
            );
            await client.query('COMMIT');
            console.log(
              JSON.stringify({
                backedUp: id,
                sha256: createHash('sha256').update(original).digest('hex'),
                deleted: deleted.rowCount,
              }),
            );
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        }
      }
    }
  } finally {
    await pool.end();
  }
}
