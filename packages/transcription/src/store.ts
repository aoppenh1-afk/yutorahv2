import { Pool, type PoolClient } from 'pg';
import { Failure } from '../../opencode-acp/src/errors.js';
import {
  normalizeTranscriptSearch,
  searchVariants,
  timestampLink,
  transcriptSearchClauses,
} from '../../yutorah-core/src/search.js';
import type { Segment } from './types.js';
import {
  interpretSpacing,
  interpretSearchRequest,
  matchingSpans,
} from '../../yutorah-core/src/search-matching.js';

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

/** Read-only access to preserved published transcripts. New work belongs to the SQLite notes coordinator. */
export class TranscriptionStore {
  constructor(readonly pool: Pool) {}
  /** Only the active, fully published transcript is exposed to readers. */
  async content(
    shiurId: string,
    includeInternal = true,
    reader: Pick<Pool, 'query'> = this.pool,
  ) {
    const result = await reader.query<{
      id: string;
      title: string;
      teacher: string;
      transcriptId: string;
      mediaUrl: string | null;
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
      `SELECT h.id,h.title,h.teacher,h.media_url AS "mediaUrl",t.id AS "transcriptId",${includeInternal ? 't.text,' : ''}t.duration_ms::float8 AS "durationMs",t.created_at AS "createdAt",
       (SELECT coalesce(jsonb_agg(jsonb_build_object('startMs',s.start_ms,'endMs',s.end_ms,'text',s.text,'speaker',s.speaker,'language',s.language) ORDER BY segment_index),'[]') FROM transcript_segments s WHERE s.transcript_id=t.id) AS segments,
       (SELECT jsonb_build_object('status',j.status,'markdown',n.markdown${includeInternal ? ",'cleanedText',j.cleaned_text" : ''})
        FROM notes_jobs j LEFT JOIN transcript_notes n ON n.id=j.id WHERE j.transcript_id=t.id
        ORDER BY (j.status='completed') DESC,j.created_at DESC LIMIT 1) AS notes
       FROM transcription_shiurim h JOIN transcripts t ON t.id=h.active_transcript_id WHERE h.id=$1`,
      [shiurId],
    );
    return result.rows[0] ?? null;
  }

  async publicContent(
    shiurId: string,
    reader: Pick<Pool, 'query'> = this.pool,
  ) {
    const c = await this.content(shiurId, false, reader);
    return (
      c && {
        id: c.id,
        title: c.title,
        teacher: c.teacher,
        mediaUrl: c.mediaUrl,
        transcriptId: c.transcriptId,
        durationMs: c.durationMs,
        createdAt: new Date(c.createdAt).toISOString(),
        segments: c.segments,
        notes: c.notes && {
          status: c.notes.status,
          markdown: c.notes.markdown,
        },
      }
    );
  }

  /** Polling never reads the transcript, timed segments, or notes body. */
  async contentStatus(shiurId: string, client: Pool | PoolClient = this.pool) {
    const result = await client.query<{
      transcriptId: string;
      notes: { status: string } | null;
    }>(
      `SELECT h.active_transcript_id AS "transcriptId",
      (SELECT jsonb_build_object('status',j.status) FROM notes_jobs j
       WHERE j.transcript_id=h.active_transcript_id
       ORDER BY (j.status='completed') DESC,j.created_at DESC LIMIT 1) AS notes
      FROM transcription_shiurim h WHERE h.id=$1 AND h.active_transcript_id IS NOT NULL`,
      [shiurId],
    );
    return result.rows[0] ?? null;
  }
  async search(
    query: string,
    expandAliases = true,
    limit = 20,
    mode: 'phrase' | 'terms' | 'smart' = 'phrase',
  ) {
    if (process.env.TRANSCRIPT_ARCHIVE_ONLY_SEARCH === 'true')
      throw new Failure('configuration');
    const variants = searchVariants(query, expandAliases);
    return transaction(this.pool, async (client) => {
      await client.query("SET LOCAL statement_timeout = '3s'");
      if (mode === 'smart') {
        await client.query("SET LOCAL pg_trgm.similarity_threshold = '0.2'");
        await client.query(
          "SET LOCAL pg_trgm.word_similarity_threshold = '0.2'",
        );
        const spacedQuery = interpretSpacing(query).term;
        const smartQuery = expandAliases
          ? interpretSearchRequest(spacedQuery).term || spacedQuery
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
