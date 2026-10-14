import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { indexedSegments } from '../../packages/transcription/src/search-index.js';
import type { Segment } from '../../packages/transcription/src/types.js';
/** Seed preserved published data directly; the removed inference queue is not a test dependency. */
export async function seedPublishedContent(
  pool: Pool,
  id: string,
  title: string,
  text: string,
  segments: Segment[],
) {
  const job = randomUUID(),
    transcript = randomUUID();
  await pool.query(
    "INSERT INTO transcription_versions(id,pipeline_version,skill_hash,skill_text,model,runtime,settings) VALUES('fixture','fixture',$1,'fixture','fixture','fixture','{}') ON CONFLICT DO NOTHING",
    ['a'.repeat(64)],
  );
  await pool.query(
    'INSERT INTO transcription_shiurim(id,title,teacher) VALUES($1,$2,$3)',
    [id, title, 'Rabbi Fixture'],
  );
  await pool.query(
    "INSERT INTO transcription_jobs(id,shiur_id,transcription_version,source_revision,skill_hash,model,status,completed_at) VALUES($1,$2,'fixture','fixture','fixture','fixture','completed',now())",
    [job, id],
  );
  await pool.query(
    "INSERT INTO transcripts(id,job_id,shiur_id,duration_ms,text,fingerprint) VALUES($1,$2,$3,10000,$4,'fixture')",
    [transcript, job, id, text],
  );
  for (const [index, s] of indexedSegments(segments).entries())
    await pool.query(
      'INSERT INTO transcript_segments(transcript_id,shiur_id,segment_index,start_ms,end_ms,text,speaker,language,search_text,search_window) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        transcript,
        id,
        index,
        s.start_ms,
        s.end_ms,
        s.text,
        s.speaker,
        s.language,
        s.search_text,
        s.search_window,
      ],
    );
  await pool.query(
    'UPDATE transcription_shiurim SET active_transcript_id=$1,latest_job_id=$2 WHERE id=$3',
    [transcript, job, id],
  );
  return { id: job, transcriptId: transcript };
}
