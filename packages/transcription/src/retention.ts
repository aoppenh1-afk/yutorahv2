import type { Pool } from 'pg';
const eligibleFrom = `FROM transcription_jobs j JOIN transcripts t ON t.job_id=j.id
    JOIN transcription_shiurim h ON h.active_transcript_id=t.id
    JOIN transcript_publications p ON p.shiur_id=h.id
    WHERE j.status='completed' AND j.completed_at<now()-interval '7 days'
    AND p.generation=p.published_generation AND NOT p.content_changed
    AND (EXISTS(SELECT 1 FROM transcription_chunks c WHERE c.job_id=j.id) OR EXISTS(SELECT 1 FROM notes_jobs n JOIN transcript_notes content ON content.id=n.id WHERE n.transcript_id=t.id AND n.status='completed' AND n.completed_at<now()-interval '7 days' AND n.cleaned_text IS NOT NULL))`;
export async function publicationRetentionBacklog(pool: Pool) {
  const row = (
    await pool.query<{ jobs: string; oldest: Date | null }>(
      `SELECT count(*) AS jobs,min(j.completed_at) AS oldest ${eligibleFrom}`,
    )
  ).rows[0];
  return {
    jobs: Number(row.jobs),
    oldestMs: row.oldest ? Math.max(0, Date.now() - row.oldest.getTime()) : 0,
  };
}

/** Keep every retryable checkpoint. Cleanup requires an acknowledged active
 * publication, completed jobs, and a seven-day recovery window. */
export async function retainPublishedStorage(
  pool: Pool,
  apply = false,
  limit = 100,
) {
  const eligible = `SELECT j.id ${eligibleFrom} ORDER BY j.completed_at LIMIT $1`;
  const ids = (await pool.query<{ id: string }>(eligible, [limit])).rows.map(
    (row) => row.id,
  );
  if (!ids.length)
    return { jobs: 0, checkpoints: 0, cleanedNotes: 0, applied: apply };
  if (!apply) {
    const chunks = await pool.query<{ count: string }>(
      'SELECT count(*) FROM transcription_chunks WHERE job_id=ANY($1::uuid[])',
      [ids],
    );
    const notes = await pool.query<{ count: string }>(
      `SELECT count(*) FROM notes_jobs n JOIN transcripts t ON t.id=n.transcript_id
      WHERE t.job_id=ANY($1::uuid[]) AND n.status='completed' AND n.completed_at<now()-interval '7 days' AND n.cleaned_text IS NOT NULL
      AND EXISTS(SELECT 1 FROM transcript_notes p WHERE p.id=n.id)`,
      [ids],
    );
    return {
      jobs: ids.length,
      checkpoints: Number(chunks.rows[0].count),
      cleanedNotes: Number(notes.rows[0].count),
      applied: false,
    };
  }
  // Recheck publication inside each mutation, including concurrent corrections.
  const chunks = await pool.query(
    `DELETE FROM transcription_chunks c USING transcription_jobs j,transcripts t,transcription_shiurim h,transcript_publications p
    WHERE c.job_id=j.id AND j.id=ANY($1::uuid[]) AND t.job_id=j.id AND h.active_transcript_id=t.id AND p.shiur_id=h.id
    AND j.status='completed' AND j.completed_at<now()-interval '7 days' AND p.generation=p.published_generation AND NOT p.content_changed`,
    [ids],
  );
  const notes = await pool.query(
    `UPDATE notes_jobs n SET cleaned_text=NULL FROM transcripts t,transcription_shiurim h,transcript_publications p
    WHERE n.transcript_id=t.id AND t.job_id=ANY($1::uuid[]) AND h.active_transcript_id=t.id AND p.shiur_id=h.id
    AND p.generation=p.published_generation AND NOT p.content_changed AND n.status='completed' AND n.completed_at<now()-interval '7 days' AND n.cleaned_text IS NOT NULL
    AND EXISTS(SELECT 1 FROM transcript_notes content WHERE content.id=n.id)`,
    [ids],
  );
  return {
    jobs: ids.length,
    checkpoints: chunks.rowCount ?? 0,
    cleanedNotes: notes.rowCount ?? 0,
    applied: true,
  };
}
