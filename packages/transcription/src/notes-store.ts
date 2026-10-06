import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Failure } from '../../antigravity-acp/src/errors.js';
import { transaction, TranscriptionStore } from './store.js';
import { publishableContent } from './public-content.js';
import { workWake } from './work-wake.js';
import type { NotesProfile } from './notes.js';

export type NotesJob = {
  id: string;
  transcript_id: string;
  lease_token: string;
  cleaned_text: string | null;
  source: string;
  model: string;
  language: NotesProfile['language'];
  runtime: string;
  transcription_skill: string;
  notes_skill: string;
  version_id: string;
};
export class NotesStore {
  constructor(
    readonly pool: Pool,
    readonly leaseSeconds = 90,
  ) {}
  async enqueueMissing(
    p: NotesProfile,
    selectedOnly = false,
    transcriptId: string | null = null,
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      await enqueueNotes(client, p, selectedOnly, transcriptId);
    });
    workWake(this.pool).notify();
  }
  async claim(selectedOnly = false): Promise<NotesJob | null> {
    const result = await this.pool.query<NotesJob>(
      `WITH exhausted AS (UPDATE notes_jobs SET status='failed',lease_token=NULL,lease_until=NULL,error='attempts_exhausted' WHERE status IN ('cleaning','generating') AND lease_until<now() AND attempt>=5 RETURNING id), candidate AS (
       SELECT j.id FROM notes_jobs j JOIN transcripts t ON t.id=j.transcript_id JOIN transcription_shiurim h ON h.active_transcript_id=t.id
       WHERE (j.status='queued' OR (j.status IN ('cleaning','generating') AND j.lease_until<now() AND j.attempt<5))
       AND (NOT $3 OR EXISTS(SELECT 1 FROM transcription_target_jobs tj JOIN transcription_targets s ON s.id=tj.target_id WHERE tj.job_id=t.job_id AND s.enabled))
       ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
       ), claimed AS (
       UPDATE notes_jobs j SET status=CASE WHEN cleaned_text IS NULL THEN 'cleaning' ELSE 'generating' END,attempt=attempt+1,lease_token=$1,lease_until=now()+$2*interval '1 second',error=NULL FROM candidate c WHERE j.id=c.id RETURNING j.*)
       SELECT c.*,t.text AS source,v.model,v.language,v.runtime,v.transcription_skill,v.notes_skill FROM claimed c JOIN transcripts t ON t.id=c.transcript_id JOIN notes_versions v ON v.id=c.version_id`,
      [randomUUID(), this.leaseSeconds, selectedOnly],
    );
    if (result.rows[0]) workWake(this.pool).notify();
    return result.rows[0] ?? null;
  }
  private async owned(job: NotesJob, sql: string, extra: unknown[] = []) {
    const result = await this.pool.query(sql, [
      job.id,
      job.lease_token,
      ...extra,
    ]);
    if (!result.rowCount) throw new Failure('lease_lost');
  }
  async heartbeat(job: NotesJob) {
    await this.owned(
      job,
      `UPDATE notes_jobs SET lease_until=now()+$3*interval '1 second' WHERE id=$1 AND lease_token=$2 AND lease_until>now()`,
      [this.leaseSeconds],
    );
  }
  async saveCleaned(job: NotesJob, text: string) {
    await this.owned(
      job,
      `UPDATE notes_jobs SET cleaned_text=$3,status='generating' WHERE id=$1 AND lease_token=$2 AND lease_until>now()`,
      [text],
    );
    workWake(this.pool).notify();
  }
  async complete(job: NotesJob, markdown: string) {
    await transaction(this.pool, async (client) => {
      const owned = await client.query(
        `SELECT id FROM notes_jobs WHERE id=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE`,
        [job.id, job.lease_token],
      );
      if (!owned.rowCount) throw new Failure('lease_lost');
      const id = (
        await client.query<{ shiur_id: string }>(
          'SELECT shiur_id FROM transcripts WHERE id=$1',
          [job.transcript_id],
        )
      ).rows[0]?.shiur_id;
      const content = id
        ? await new TranscriptionStore(this.pool).publicContent(id, client)
        : null;
      if (content?.transcriptId === job.transcript_id) {
        try {
          publishableContent({
            ...content,
            notes: { status: 'completed', markdown },
          });
        } catch {
          throw new Failure('publication_invalid');
        }
      }
      await client.query(
        `INSERT INTO transcript_notes(id,transcript_id,markdown) VALUES($1,$2,$3)`,
        [job.id, job.transcript_id, markdown],
      );
      await client.query(
        `UPDATE notes_jobs SET status='completed',completed_at=now(),lease_token=NULL,lease_until=NULL,error=NULL WHERE id=$1`,
        [job.id],
      );
    });
    workWake(this.pool).notify();
  }
  async finishFailure(job: NotesJob, code: string, shutdown = false) {
    await this.pool.query(
      `UPDATE notes_jobs SET status=CASE WHEN $4 THEN 'queued' ELSE 'failed' END,error=$3,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>now()`,
      [job.id, job.lease_token, code, shutdown],
    );
    workWake(this.pool).notify();
  }
  async retry(id: string) {
    await this.pool.query(
      `UPDATE notes_jobs SET status='queued',attempt=0,error=NULL,completed_at=NULL WHERE id=$1 AND status IN ('failed','cancelled')`,
      [id],
    );
    workWake(this.pool).notify();
  }
  async cancel(id: string) {
    await this.pool.query(
      `UPDATE notes_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1 AND status NOT IN ('completed','cancelled')`,
      [id],
    );
    workWake(this.pool).notify();
  }
}

export async function enqueueNotes(
  client: PoolClient,
  p: NotesProfile,
  selectedOnly = false,
  transcriptId: string | null = null,
) {
  await client.query(
    `INSERT INTO notes_versions(id,model,language,runtime,transcription_skill,notes_skill) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [p.id, p.model, p.language, p.runtime, p.transcriptionSkill, p.notesSkill],
  );
  await client.query(
    `INSERT INTO notes_jobs(id,transcript_id,version_id)
         SELECT gen_random_uuid(),t.id,$1 FROM transcripts t JOIN transcription_shiurim h ON h.active_transcript_id=t.id
         WHERE ($3::uuid IS NULL OR t.id=$3) AND (NOT $2 OR EXISTS (SELECT 1 FROM transcription_target_jobs tj JOIN transcription_targets s ON s.id=tj.target_id WHERE tj.job_id=t.job_id AND s.enabled))
         AND NOT EXISTS(SELECT 1 FROM notes_jobs j WHERE j.transcript_id=t.id)
         ON CONFLICT DO NOTHING`,
    [p.id, selectedOnly, transcriptId],
  );
}
