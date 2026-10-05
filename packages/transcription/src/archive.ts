import {
  normalizeTranscriptSearch,
  searchVariants,
  timestampLink,
  transcriptSearchClauses,
} from '../../yutorah-core/src/search.js';
import { wordMatch } from '../../yutorah-core/src/search-matching.js';
import { publicContent, type PublicContent } from './public-content.js';
import { spellingKeys, spellingBucket } from './spelling-base.js';

export interface ArchiveStatement {
  bind(...values: unknown[]): ArchiveStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface ArchiveDatabase {
  prepare(sql: string): ArchiveStatement;
  batch(statements: ArchiveStatement[]): Promise<unknown[]>;
}
export interface ArchiveObjects {
  put(
    key: string,
    body: string,
    options?: { httpMetadata: { contentType: string; cacheControl: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}
type Item = {
  id: string;
  generation: number;
  version: string;
  search_version: string;
  transcript_id: string;
  object_key: string;
  notes_status: string | null;
  segment_count: number;
};
export type Publication = { generation: number; content: PublicContent };
const encode = new TextEncoder();
export async function contentHash(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', encode.encode(text));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export class TranscriptArchive {
  constructor(
    private db: ArchiveDatabase,
    private objects: ArchiveObjects,
  ) {}
  async item(id: string) {
    return this.db
      .prepare('SELECT * FROM archive_items WHERE id=?')
      .bind(id)
      .first<Item>();
  }
  async status(id: string) {
    const item = await this.item(id);
    return (
      item && {
        transcriptId: item.transcript_id,
        version: item.version,
        notes: item.notes_status ? { status: item.notes_status } : null,
      }
    );
  }
  async content(id: string, version?: string) {
    const body = await this.contentBody(id, version);
    if (!body) return null;
    if ((await contentHash(body.text)) !== body.version)
      throw new Error('Published object failed verification.');
    return {
      ...(JSON.parse(body.text) as PublicContent),
      version: body.version,
    };
  }
  async contentBody(id: string, version?: string) {
    // Versioned reads skip the changing pointer. The namespace includes the ID.
    const item = version ? null : await this.item(id);
    const key = version
      ? `transcripts/${id}/${version}.json`
      : item?.object_key;
    if (!key) return null;
    const object = await this.objects.get(key);
    if (!object) {
      if (version) return null;
      throw new Error('Published object unavailable.');
    }
    const text = await object.text();
    const hash = version ?? item!.version;
    return { text, version: hash };
  }
  async publish(
    publication: Publication,
    options: { spellingBaseSeeded?: boolean } = {},
  ) {
    const { generation } = publication;
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error('Invalid generation.');
    const content = publicContent(publication.content);
    const text = JSON.stringify(content);
    if (encode.encode(text).length > 8 * 1024 * 1024)
      throw new Error('Transcript is too large.');
    const version = await contentHash(text);
    // Notes and metadata updates reuse timed-text rows instead of rewriting
    // the FTS index. This matters to D1 Free's daily row-write allowance.
    const searchVersion = await contentHash(JSON.stringify(content.segments));
    const current = await this.item(content.id);
    if (current && current.generation >= generation) {
      if (current.generation === generation && current.version !== version)
        throw new Error('Generation conflict.');
      return {
        id: content.id,
        version: current.version,
        generation: current.generation,
        applied: false,
      };
    }
    const key = `transcripts/${content.id}/${version}.json`;
    await this.objects.put(key, text, {
      httpMetadata: {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
    const uploaded = await this.objects.get(key);
    if (!uploaded || (await contentHash(await uploaded.text())) !== version)
      throw new Error('Upload verification failed.');
    const statements: ArchiveStatement[] = [];
    const words = new Set<string>();
    for (
      let i = 0;
      current?.search_version !== searchVersion && i < content.segments.length;
      i++
    ) {
      const s = content.segments[i];
      const normalized = normalizeTranscriptSearch(s.text);
      const window = normalizeTranscriptSearch(
        s.text + ' ' + (content.segments[i + 1]?.text ?? ''),
      );
      statements.push(
        this.db
          .prepare(`INSERT OR IGNORE INTO archive_segments
        (shiur_id,version,generation,segment_index,start_ms,end_ms,text,search_text,search_window) VALUES(?,?,?,?,?,?,?,?,?)`)
          .bind(
            content.id,
            searchVersion,
            generation,
            i,
            s.startMs,
            s.endMs,
            s.text,
            normalized,
            window,
          ),
      );
      if (!options.spellingBaseSeeded)
        for (const w of normalized.split(' '))
          if (w.length >= 3 && w.length <= 64) words.add(w);
    }
    // Every statement has fewer than D1's 100 bound-parameter limit.
    for (const word of words) {
      statements.push(
        this.db
          .prepare('INSERT OR IGNORE INTO archive_words(word) VALUES(?)')
          .bind(word),
      );
      for (const k of spellingKeys(word))
        statements.push(
          this.db
            .prepare(
              'INSERT OR IGNORE INTO archive_spelling_keys(key,word) VALUES(?,?)',
            )
            .bind(k, word),
        );
    }
    for (let i = 0; i < statements.length; i += 40)
      await this.db.batch(statements.slice(i, i + 40));
    // The pointer changes only after every object and search row exists. A stale
    // concurrent publisher cannot replace a newer generation.
    await this.db
      .prepare(`INSERT INTO archive_items(id,generation,version,transcript_id,title,teacher,media_url,object_key,notes_status,segment_count,published_at,search_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,version=excluded.version,search_version=excluded.search_version,
      transcript_id=excluded.transcript_id,title=excluded.title,teacher=excluded.teacher,media_url=excluded.media_url,
      object_key=excluded.object_key,notes_status=excluded.notes_status,segment_count=excluded.segment_count,published_at=excluded.published_at
      WHERE excluded.generation>archive_items.generation`)
      .bind(
        content.id,
        generation,
        version,
        content.transcriptId,
        content.title,
        content.teacher,
        content.mediaUrl ?? null,
        key,
        content.notes?.status ?? null,
        content.segments.length,
        new Date().toISOString(),
        searchVersion,
      )
      .run();
    const active = await this.item(content.id);
    if (!active) throw new Error('Publication activation failed.');
    await this.db
      .prepare(
        'DELETE FROM archive_segments WHERE shiur_id=? AND generation<? AND version<>?',
      )
      .bind(content.id, active.generation, active.search_version)
      .run();
    return {
      id: content.id,
      version: active.version,
      generation: active.generation,
      applied: active.version === version,
    };
  }
  async search(
    query: string,
    aliases = true,
    limit = 20,
    mode: 'phrase' | 'terms' | 'smart' = 'smart',
  ) {
    const variants = searchVariants(query, aliases);
    const candidates = new Map<string, string[]>();
    if (mode === 'smart') {
      for (const word of normalizeTranscriptSearch(query)
        .split(' ')
        .filter((w) => w.length >= 3 && w.length <= 64)) {
        const keys = spellingKeys(word);
        const rows = await this.db
          .prepare(
            `WITH lookup(bucket,key) AS (VALUES ${keys.map(() => '(?,?)').join(',')}),
             candidates(word) AS (
               SELECT word FROM archive_spelling_keys WHERE key IN (${keys.map(() => '?').join(',')})
               UNION
               SELECT j.value FROM lookup l JOIN archive_spelling_base b ON b.bucket=l.bucket
               JOIN json_each(b.body, '$."'||l.key||'"') j
             ) SELECT word FROM candidates LIMIT 128`,
          )
          .bind(...keys.flatMap((key) => [spellingBucket(key), key]), ...keys)
          .all<{ word: string }>();
        candidates.set(
          word,
          rows.results.map((r) => r.word).filter((w) => wordMatch(word, w) > 0),
        );
      }
    }
    const clauses = transcriptSearchClauses(query, candidates, aliases);
    if (mode === 'smart' && !clauses.all) return [];
    const toFTS = (clause: string) =>
      clause
        .replace(/'([^']*)':\*/g, '"$1"*')
        .replace(/'([^']*)'/g, '"$1"')
        .replace(/ & /g, ' AND ')
        .replace(/ \| /g, ' OR ');
    const match =
      mode === 'smart'
        ? `search_window:(${toFTS(clauses.all)}) AND search_text:(${toFTS(clauses.any)})`
        : variants
            .map((v) =>
              mode === 'phrase'
                ? `search_window:"${v}"`
                : 'search_text:(' +
                  v
                    .split(' ')
                    .map((w) => '"' + w + '"')
                    .join(' AND ') +
                  ')',
            )
            .join(' OR ');
    if (!match) return [];
    const anchor =
      mode === 'phrase'
        ? ' AND (' +
          variants
            .map(
              () =>
                "instr(' '||s.search_window||' ',?) BETWEEN 1 AND length(s.search_text)+1",
            )
            .join(' OR ') +
          ')'
        : '';
    const rows = await this.db
      .prepare(`SELECT s.shiur_id,s.start_ms,s.end_ms,substr(s.text,1,500) AS text,
      h.title,h.teacher,h.media_url,bm25(archive_fts) AS rank
      FROM archive_fts JOIN archive_segments s ON s.rowid=archive_fts.rowid
      JOIN archive_items h ON h.id=s.shiur_id AND h.search_version=s.version
      WHERE archive_fts MATCH ?${anchor} ORDER BY rank,s.shiur_id,s.segment_index LIMIT ?`)
      .bind(
        match,
        ...(mode === 'phrase' ? variants.map((v) => ' ' + v + ' ') : []),
        limit,
      )
      .all<{
        shiur_id: string;
        start_ms: number;
        end_ms: number;
        text: string;
        title: string;
        teacher: string;
        media_url: string | null;
      }>();
    const normalized = normalizeTranscriptSearch(query);
    return rows.results.slice(0, limit).map((row) => ({
      shiurId: row.shiur_id,
      title: row.title,
      teacher: row.teacher,
      mediaUrl: row.media_url,
      startMs: row.start_ms,
      endMs: row.end_ms,
      text: row.text.slice(0, 500),
      matched: normalized,
      href: timestampLink(row.shiur_id, row.start_ms),
      aliasesExpanded: clauses.aliasesExpanded,
      spellingExpanded: clauses.spellingExpanded,
    }));
  }
}
