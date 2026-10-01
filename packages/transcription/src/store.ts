import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { Failure } from '../../antigravity-acp/src/errors.js';
import {
  normalizeTranscriptSearch,
  searchVariants,
  timestampLink,
  transcriptSearchClauses,
} from '../../yutorah-core/src/search.js';
import { digest, objectDigest } from './fingerprint.js';
import {
  versions,
  type Range,
  type Segment,
  type Settings,
  type Transcript,
} from './types.js';
import { validRanges } from './planning.js';
import { validSegments } from './transcript.js';
import {
  interpretSpacing,
  interpretSearchRequest,
  matchingSpans,
} from '../../yutorah-core/src/search-matching.js';

export type Profile = {
  id: string;
  skill: string;
  skillHash: string;
  runtime: string;
  settings: Settings;
};
export function profile(
  skill: string,
  settings: Settings,
  runtime: string,
): Profile {
  if (!skill.trim() || Buffer.byteLength(skill) > 512 * 1024)
    throw new Failure('configuration');
  const skillHash = digest(skill);
  return {
    id: objectDigest({ skillHash, settings, runtime, versions }),
    skill,
    skillHash,
    settings,
    runtime,
  };
}
export type Job = {
  id: string;
  shiur_id: string;
  source_url: string | null;
  lease_token: string;
  transcription_version: string;
  skill_hash: string;
  model: string;
  skill_text: string;
  settings: Settings;
  runtime: string;
  fingerprint: string | null;
  manifest: unknown;
  manifest_digest: string | null;
  attempt: number;
};
export type Manifest = { version: 1; durationMs: number; ranges: Range[] };
export type AcceptedChunk = {
  index: number;
  range: Range;
  segments: Segment[];
};
export type Checkpoints = {
  load: (index: number, range: Range) => Promise<Segment[] | null>;
  save: (index: number, range: Range, segments: Segment[]) => Promise<void>;
};

const MAX_JOB_ATTEMPTS = 5;

function excerpt(text: string, term: string, tolerant = false): string {
  if (text.length <= 360) return text;
  const normalized = normalizeTranscriptSearch(text);
  const found = normalized.indexOf(term);
  let approximate =
    found < 0
      ? 0
      : Math.floor((found / Math.max(1, normalized.length)) * text.length);
  if (found < 0 && tolerant)
    approximate = matchingSpans(text, term)[0]?.start ?? 0;
  const start = Math.max(0, Math.min(text.length - 360, approximate - 100));
  return `${start ? '…' : ''}${text.slice(start, start + 360)}${start + 360 < text.length ? '…' : ''}`;
}

export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export class TranscriptionStore {
  constructor(
    readonly pool: Pool,
    readonly leaseSeconds = 90,
  ) {}

  /** A model change can move untouched jobs without discarding paid checkpoints. */
  async reconfigureQueued(p: Profile, selectedOnly = false): Promise<number> {
    return transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO transcription_versions(id,pipeline_version,skill_hash,skill_text,model,runtime,settings)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          p.id,
          versions.pipeline,
          p.skillHash,
          p.skill,
          p.settings.model,
          p.runtime,
          p.settings,
        ],
      );
      const updated = await client.query(
        `UPDATE transcription_jobs j SET transcription_version=$1,model=$2
         FROM transcription_versions v WHERE v.id=j.transcription_version
         AND j.status='queued' AND j.attempt=0 AND j.fingerprint IS NULL
         AND NOT j.cancel_requested AND j.transcription_version<>$1
         AND v.pipeline_version=$3 AND v.skill_hash=$4 AND v.runtime=$5
         AND (v.settings-'model')=($6::jsonb-'model')
         AND NOT EXISTS(SELECT 1 FROM transcription_chunks c WHERE c.job_id=j.id)
         AND NOT EXISTS(SELECT 1 FROM transcription_jobs other WHERE other.shiur_id=j.shiur_id AND other.source_revision=j.source_revision AND other.transcription_version=$1)
         AND (NOT $7 OR EXISTS(SELECT 1 FROM transcription_target_jobs tj JOIN transcription_targets t ON t.id=tj.target_id WHERE tj.job_id=j.id AND t.enabled))`,
        [
          p.id,
          p.settings.model,
          versions.pipeline,
          p.skillHash,
          p.runtime,
          p.settings,
          selectedOnly,
        ],
      );
      return updated.rowCount ?? 0;
    });
  }

  /** Catalog ingestion and queue insertion are one transaction and idempotent. */
  async enqueue(
    shiur: {
      id: string;
      title: string;
      teacher: string;
      mediaUrl?: string;
      sourceRevision?: string;
    },
    p: Profile,
    priority = 0,
  ): Promise<string> {
    return transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO transcription_versions(id,pipeline_version,skill_hash,skill_text,model,runtime,settings)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          p.id,
          versions.pipeline,
          p.skillHash,
          p.skill,
          p.settings.model,
          p.runtime,
          p.settings,
        ],
      );
      await client.query(
        `INSERT INTO transcription_shiurim(id,title,teacher,media_url) VALUES($1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,teacher=EXCLUDED.teacher,media_url=EXCLUDED.media_url,updated_at=now()`,
        [shiur.id, shiur.title, shiur.teacher, shiur.mediaUrl ?? null],
      );
      const result = await client.query<{ id: string }>(
        `INSERT INTO transcription_jobs(id,shiur_id,transcription_version,source_revision,source_url,skill_hash,model,priority)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(shiur_id,transcription_version,source_revision)
        DO UPDATE SET priority=greatest(transcription_jobs.priority,EXCLUDED.priority) RETURNING id`,
        [
          randomUUID(),
          shiur.id,
          p.id,
          shiur.sourceRevision ?? shiur.mediaUrl ?? 'initial',
          shiur.mediaUrl ?? null,
          p.skillHash,
          p.settings.model,
          priority,
        ],
      );
      const id = result.rows[0].id;
      // Re-ingesting an older duplicate must not demote a newer requested version.
      await client.query(
        `UPDATE transcription_shiurim s SET latest_job_id=$2 WHERE s.id=$1 AND
        (s.latest_job_id IS NULL OR (SELECT created_at FROM transcription_jobs WHERE id=s.latest_job_id)
          <= (SELECT created_at FROM transcription_jobs WHERE id=$2))`,
        [shiur.id, id],
      );
      return id;
    });
  }
  async claim(selectedOnly = false): Promise<Job | null> {
    await this.pool.query(
      `UPDATE transcription_jobs SET status='failed',completed_at=now(),lease_token=NULL,lease_until=NULL,
       error=jsonb_build_object('code','attempts_exhausted')
       WHERE cancel_requested=false AND status IN ('downloading','preparing','transcribing','merging')
       AND lease_until < now() AND attempt >= $1`,
      [MAX_JOB_ATTEMPTS],
    );
    const token = randomUUID();
    const result = await this.pool.query<Job>(
      `WITH candidate AS (
      SELECT id FROM transcription_jobs WHERE cancel_requested=false AND
        (NOT $4 OR EXISTS (SELECT 1 FROM transcription_target_jobs tj JOIN transcription_targets t ON t.id=tj.target_id WHERE tj.job_id=transcription_jobs.id AND t.enabled)) AND
        ((status='queued' AND available_at <= now()) OR
        (status IN ('downloading','preparing','transcribing','merging') AND lease_until < now() AND attempt < $3))
      ORDER BY priority DESC,created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE transcription_jobs j SET status='downloading',attempt=attempt+1,started_at=coalesce(started_at,now()),
        lease_token=$1,lease_until=now()+$2*interval '1 second',error=NULL
      FROM candidate c WHERE j.id=c.id RETURNING j.*
    ) SELECT c.*,v.skill_text,v.settings,v.runtime FROM claimed c JOIN transcription_versions v ON v.id=c.transcription_version`,
      [token, this.leaseSeconds, MAX_JOB_ATTEMPTS, selectedOnly],
    );
    return result.rows[0] ?? null;
  }
  async heartbeat(job: Job): Promise<void> {
    const result = await this.pool.query(
      `UPDATE transcription_jobs SET lease_until=now()+$3*interval '1 second'
      WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND cancel_requested=false
      AND status IN ('downloading','preparing','transcribing','merging') RETURNING id`,
      [job.id, job.lease_token, this.leaseSeconds],
    );
    if (!result.rowCount) throw new Failure('lease_lost');
  }
  private async guard(client: PoolClient, job: Job): Promise<void> {
    const result = await client.query(
      `SELECT id FROM transcription_jobs WHERE id=$1 AND lease_token=$2 AND lease_until>now()
      AND cancel_requested=false AND status IN ('downloading','preparing','transcribing','merging') FOR UPDATE`,
      [job.id, job.lease_token],
    );
    if (!result.rowCount) throw new Failure('lease_lost');
  }
  async stage(
    job: Job,
    status: 'downloading' | 'preparing' | 'transcribing' | 'merging',
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE transcription_jobs SET status=$3 WHERE id=$1 AND lease_token=$2
      AND lease_until>now() AND cancel_requested=false RETURNING id`,
      [job.id, job.lease_token, status],
    );
    if (!result.rowCount) throw new Failure('lease_lost');
  }
  savedManifest(job: Job, key: string, durationMs: number): Manifest | null {
    const m = job.manifest as Manifest | null;
    if (
      job.fingerprint !== key ||
      !m ||
      m.version !== 1 ||
      m.durationMs !== durationMs ||
      objectDigest(m) !== job.manifest_digest ||
      !validRanges(m.ranges, durationMs / 1000)
    )
      return null;
    return m;
  }
  async manifest(
    job: Job,
    key: string,
    audioHash: string,
    manifest: Manifest,
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      await this.guard(client, job);
      // Invalid manifests cannot leave apparently valid parts attached to different ranges.
      if (!this.savedManifest(job, key, manifest.durationMs))
        await client.query('DELETE FROM transcription_chunks WHERE job_id=$1', [
          job.id,
        ]);
      await client.query(
        `UPDATE transcription_jobs SET fingerprint=$3,audio_hash=$4,manifest=$5,manifest_digest=$6 WHERE id=$1 AND lease_token=$2`,
        [
          job.id,
          job.lease_token,
          key,
          audioHash,
          manifest,
          objectDigest(manifest),
        ],
      );
    });
    job.fingerprint = key;
    job.manifest = manifest;
    job.manifest_digest = objectDigest(manifest);
  }
  checkpoints(job: Job, key: string): Checkpoints {
    return {
      load: async (index, range) => {
        const result = await this.pool.query<{
          payload: AcceptedChunk;
          digest: string;
        }>(
          'SELECT payload,digest FROM transcription_chunks WHERE job_id=$1 AND fingerprint=$2 AND chunk_index=$3',
          [job.id, key, index],
        );
        const row = result.rows[0];
        if (
          !row ||
          objectDigest(row.payload) !== row.digest ||
          row.payload.index !== index ||
          objectDigest(row.payload.range) !== objectDigest(range) ||
          !validSegments(
            row.payload.segments,
            Math.round((range.end - range.start) * 1000),
          )
        )
          return null;
        return row.payload.segments;
      },
      save: async (index, range, segments) => {
        if (
          !validSegments(segments, Math.round((range.end - range.start) * 1000))
        )
          throw new Failure('invalid_transcript');
        const payload: AcceptedChunk = { index, range, segments };
        await transaction(this.pool, async (client) => {
          await this.guard(client, job);
          await client.query(
            `INSERT INTO transcription_chunks(job_id,fingerprint,chunk_index,payload,digest) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(job_id,fingerprint,chunk_index) DO UPDATE SET payload=EXCLUDED.payload,digest=EXCLUDED.digest,accepted_at=now()`,
            [job.id, key, index, payload, objectDigest(payload)],
          );
        });
      },
    };
  }
  async complete(job: Job, transcript: Transcript): Promise<void> {
    if (
      !validSegments(transcript.segments, transcript.durationMs) ||
      !job.fingerprint
    )
      throw new Failure('invalid_transcript');
    await transaction(this.pool, async (client) => {
      await this.guard(client, job);
      const id = randomUUID();
      await client.query(
        `INSERT INTO transcripts(id,job_id,shiur_id,duration_ms,text,fingerprint) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          id,
          job.id,
          job.shiur_id,
          transcript.durationMs,
          transcript.text,
          job.fingerprint,
        ],
      );
      const normalized = transcript.segments.map((s) =>
        normalizeTranscriptSearch(s.text),
      );
      for (let offset = 0; offset < transcript.segments.length; offset += 250) {
        const batch = transcript.segments
          .slice(offset, offset + 250)
          .map((s, i) => ({
            segment_index: offset + i,
            start_ms: s.startMs,
            end_ms: s.endMs,
            text: s.text,
            speaker: s.speaker,
            language: s.language,
            search_text: normalized[offset + i],
            // Up to 16 query words can span any number of short adjacent segments.
            search_window: [
              normalized[offset + i],
              normalized
                .slice(offset + i + 1, offset + i + 17)
                .join(' ')
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 15)
                .join(' '),
            ]
              .join(' ')
              .trim(),
          }));
        await client.query(
          `INSERT INTO transcript_segments(transcript_id,shiur_id,segment_index,start_ms,end_ms,speaker,language,text,search_text,search_window)
          SELECT $1,$2,x.segment_index,x.start_ms,x.end_ms,x.speaker,x.language,x.text,x.search_text,x.search_window
          FROM jsonb_to_recordset($3::jsonb) AS x(segment_index int,start_ms bigint,end_ms bigint,speaker text,language text,text text,search_text text,search_window text)`,
          [id, job.shiur_id, JSON.stringify(batch)],
        );
      }
      await client.query(
        'UPDATE transcription_shiurim SET active_transcript_id=$2 WHERE id=$1 AND latest_job_id=$3',
        [job.shiur_id, id, job.id],
      );
      await client.query(
        `UPDATE transcription_jobs SET status='completed',completed_at=now(),lease_token=NULL,lease_until=NULL,error=NULL WHERE id=$1`,
        [job.id],
      );
    });
  }
  async finishFailure(job: Job, code: string, shutdown = false): Promise<void> {
    await this.pool.query(
      `UPDATE transcription_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' WHEN $4 THEN 'queued' ELSE 'failed' END,
      lease_token=NULL,lease_until=NULL,error=jsonb_build_object('code',$3::text),available_at=now()+interval '5 seconds'
      WHERE id=$1 AND lease_token=$2 AND lease_until>now()`,
      [job.id, job.lease_token, code, shutdown],
    );
  }
  async cancel(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE transcription_jobs SET cancel_requested=true,status='cancelled',lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND status NOT IN ('completed','cancelled')`,
      [id],
    );
  }
  async retry(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE transcription_jobs SET status='queued',cancel_requested=false,error=NULL,attempt=0,available_at=now(),completed_at=NULL
      WHERE id=$1 AND status IN ('failed','cancelled')`,
      [id],
    );
  }
  /** Only the active, fully published transcript is exposed to readers. */
  async content(shiurId: string) {
    const result = await this.pool.query<{
      id: string;
      title: string;
      teacher: string;
      transcriptId: string;
      text: string;
      durationMs: number;
      createdAt: string;
      segments: Segment[];
      notes: {
        status: string;
        markdown: string | null;
        cleanedText: string | null;
      } | null;
    }>(
      `SELECT h.id,h.title,h.teacher,t.id AS "transcriptId",t.text,t.duration_ms::float8 AS "durationMs",t.created_at AS "createdAt",
       (SELECT coalesce(jsonb_agg(jsonb_build_object('startMs',s.start_ms,'endMs',s.end_ms,'text',s.text,'speaker',s.speaker,'language',s.language) ORDER BY segment_index),'[]') FROM transcript_segments s WHERE s.transcript_id=t.id) AS segments,
       (SELECT jsonb_build_object('status',j.status,'markdown',n.markdown,'cleanedText',j.cleaned_text)
        FROM notes_jobs j LEFT JOIN transcript_notes n ON n.id=j.id WHERE j.transcript_id=t.id
        ORDER BY (j.status='completed') DESC,j.created_at DESC LIMIT 1) AS notes
       FROM transcription_shiurim h JOIN transcripts t ON t.id=h.active_transcript_id WHERE h.id=$1`,
      [shiurId],
    );
    return result.rows[0] ?? null;
  }
  async catalogCursor(name: 'recent' | 'backfill'): Promise<number> {
    const result = await this.pool.query<{ next_page: number }>(
      'SELECT next_page FROM transcription_catalog_cursors WHERE name=$1',
      [name],
    );
    if (!result.rows[0]) throw new Failure('configuration');
    return result.rows[0].next_page;
  }
  async recentCatalogCutoff(lookbackDays: number): Promise<number> {
    const result = await this.pool.query<{ last_complete_at: Date }>(
      "SELECT last_complete_at FROM transcription_catalog_cursors WHERE name='recent'",
    );
    if (!result.rows[0]) throw new Failure('configuration');
    return (
      Math.min(Date.now(), result.rows[0].last_complete_at.getTime()) -
      lookbackDays * 86_400_000
    );
  }
  async advanceCatalogCursor(
    name: 'recent' | 'backfill',
    expected: number,
    next: number,
    complete = false,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE transcription_catalog_cursors SET next_page=$3,updated_at=now(),
       last_complete_at=CASE WHEN $4 THEN now() ELSE last_complete_at END
       WHERE name=$1 AND next_page=$2 RETURNING name`,
      [name, expected, next, complete],
    );
    if (!result.rowCount) throw new Failure('lease_lost');
  }
  async search(
    query: string,
    expandAliases = true,
    limit = 20,
    mode: 'phrase' | 'terms' | 'smart' = 'phrase',
  ) {
    const variants = searchVariants(query, expandAliases);
    return transaction(this.pool, async (client) => {
      await client.query("SET LOCAL statement_timeout = '3s'");
      if (mode === 'smart') {
        await client.query("SET LOCAL pg_trgm.similarity_threshold = '0.2'");
        await client.query(
          "SET LOCAL pg_trgm.word_similarity_threshold = '0.2'",
        );
        const smartQuery = expandAliases
          ? interpretSearchRequest(interpretSpacing(query).term).term
          : query;
        const words = normalizeTranscriptSearch(smartQuery)
          .split(' ')
          .filter(
            (word) =>
              word.length >= 3 && word.length <= 64 && !/\p{N}/u.test(word),
          );
        const vocabulary = await client.query<{ term: string; word: string }>(
          `
          SELECT q.term,w.word FROM unnest($1::text[]) AS q(term)
          CROSS JOIN LATERAL (
            SELECT word FROM transcript_search_words
            WHERE word % q.term OR word %> q.term OR word LIKE q.term || '%'
            ORDER BY similarity(word,q.term) DESC,word LIMIT 128
          ) w`,
          [[...new Set(words)]],
        );
        const candidates = new Map<string, string[]>();
        for (const { term, word } of vocabulary.rows)
          candidates.set(term, [...(candidates.get(term) ?? []), word]);
        const clauses = transcriptSearchClauses(
          query,
          candidates,
          expandAliases,
        );
        const literal = transcriptSearchClauses(query, new Map(), false);
        const result = await client.query<{
          shiur_id: string;
          title: string;
          teacher: string;
          media_url: string | null;
          start_ms: string;
          end_ms: string;
          text: string;
          literal_match: boolean;
        }>(
          `
          SELECT s.shiur_id,h.title,h.teacher,h.media_url,s.start_ms,s.end_ms,s.text,
            s.search_window_tokens @@ to_tsquery('simple',$4) AS literal_match
          FROM transcript_segments s JOIN transcription_shiurim h ON h.active_transcript_id=s.transcript_id
          WHERE s.search_window_tokens @@ to_tsquery('simple',$1)
            AND s.search_tokens @@ to_tsquery('simple',$2)
          ORDER BY literal_match DESC,ts_rank_cd(s.search_tokens,to_tsquery('simple',$1)) DESC,s.shiur_id,s.segment_index
          LIMIT $3`,
          [
            clauses.all,
            clauses.any,
            Math.max(1, Math.min(100, limit)),
            literal.all,
          ],
        );
        return result.rows.map((row) => ({
          shiurId: row.shiur_id,
          title: row.title,
          teacher: row.teacher,
          mediaUrl: row.media_url,
          startMs: Number(row.start_ms),
          endMs: Number(row.end_ms),
          text: excerpt(row.text, normalizeTranscriptSearch(query), true),
          matched: normalizeTranscriptSearch(query),
          href: timestampLink(row.shiur_id, Number(row.start_ms)),
          aliasesExpanded: clauses.aliasesExpanded,
          spellingExpanded: clauses.spellingExpanded && !row.literal_match,
        }));
      }
      const result = await client.query<{
        shiur_id: string;
        title: string;
        teacher: string;
        media_url: string | null;
        start_ms: string;
        end_ms: string;
        text: string;
        matched: string;
      }>(
        `
        SELECT DISTINCT ON (s.transcript_id,s.segment_index) s.shiur_id,h.title,h.teacher,h.media_url,s.start_ms,s.end_ms,s.text,q.term AS matched
        FROM transcript_segments s JOIN transcription_shiurim h ON h.active_transcript_id=s.transcript_id
        CROSS JOIN unnest($1::text[]) q(term)
        WHERE ${
          mode === 'terms'
            ? "s.search_tokens @@ plainto_tsquery('simple',q.term)"
            : "s.search_window LIKE '%' || q.term || '%' AND position(' ' || q.term || ' ' IN ' ' || s.search_window || ' ') BETWEEN 1 AND length(s.search_text)+1"
        }
        ORDER BY s.transcript_id,s.segment_index LIMIT $2`,
        [variants, Math.max(1, Math.min(100, limit))],
      );
      return result.rows.map((row) => ({
        shiurId: row.shiur_id,
        title: row.title,
        teacher: row.teacher,
        mediaUrl: row.media_url,
        startMs: Number(row.start_ms),
        endMs: Number(row.end_ms),
        text: excerpt(row.text, row.matched),
        matched: row.matched,
        href: timestampLink(row.shiur_id, Number(row.start_ms)),
        aliasesExpanded: expandAliases && variants.length > 1,
      }));
    });
  }
}
