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
    readonly beforePublication?: (statusOnly?: boolean) => Promise<void>,
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
        searchVersion: item.search_version,
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
    const text = await this.expandObject(await object.text());
    const hash = version ?? item!.version;
    return { text, version: hash };
  }
  private async expandObject(text: string) {
    if (!text.startsWith('{"format":2,')) return text;
    const manifest = JSON.parse(text) as {
      prefix: string;
      segments: string;
      suffix: string;
    };
    const segments = await this.objects.get(manifest.segments);
    if (!segments) throw new Error('Published timed text unavailable.');
    return manifest.prefix + (await segments.text()) + manifest.suffix;
  }
  /** Transient notes states change only the small pointer, never immutable text. */
  async updateStatus(value: {
    id: string;
    generation: number;
    transcriptId: string;
    notes: { status: string } | null;
  }) {
    await this.db
      .prepare(
        `UPDATE archive_items SET generation=?,notes_status=? WHERE id=? AND transcript_id=? AND generation<?`,
      )
      .bind(
        value.generation,
        value.notes?.status ?? null,
        value.id,
        value.transcriptId,
        value.generation,
      )
      .run();
    const item = await this.item(value.id);
    if (
      !item ||
      item.transcript_id !== value.transcriptId ||
      item.generation < value.generation
    )
      return null;
    return {
      id: value.id,
      version: item.version,
      generation: item.generation,
      applied: false,
    };
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
    if (current?.version !== version) {
      const segmentsKey = `transcripts/${content.id}/segments/${searchVersion}.json`;
      const segmentsText = JSON.stringify(content.segments);
      await this.objects.put(segmentsKey, segmentsText);
      const marker = ',"segments":';
      const prefix = text.slice(0, text.indexOf(marker) + marker.length);
      const suffix = text.slice(prefix.length + segmentsText.length);
      // A tiny manifest references timed text shared by every notes/metadata version.
      await this.objects.put(
        key,
        JSON.stringify({ format: 2, prefix, segments: segmentsKey, suffix }),
        {
          httpMetadata: {
            contentType: 'application/json; charset=utf-8',
            cacheControl: 'public, max-age=31536000, immutable',
          },
        },
      );
      const uploaded = await this.objects.get(key);
      if (
        !uploaded ||
        (await contentHash(await this.expandObject(await uploaded.text()))) !==
          version
      )
        throw new Error('Upload verification failed.');
    }
    const statements: ArchiveStatement[] = [];
    const staged = new Set(
      (
        await this.db
          .prepare(
            'SELECT segment_index FROM archive_segments WHERE shiur_id=? AND version=?',
          )
          .bind(content.id, searchVersion)
          .all<{ segment_index: number }>()
      ).results.map((row) => row.segment_index),
    );
    const words = new Set<string>();
    const segmentRows: unknown[][] = [];
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
      if (!staged.has(i))
        segmentRows.push([
          content.id,
          searchVersion,
          generation,
          i,
          s.startMs,
          s.endMs,
          s.text,
          normalized,
          window,
        ]);
      if (!options.spellingBaseSeeded)
        for (const w of normalized.split(' '))
          if (w.length >= 3 && w.length <= 64) words.add(w);
    }
    for (let i = 0; i < segmentRows.length; i += 11) {
      const group = segmentRows.slice(i, i + 11);
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO archive_segments(shiur_id,version,generation,segment_index,start_ms,end_ms,text,search_text,search_window) VALUES ${group.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`,
          )
          .bind(...group.flat()),
      );
    }
    // Exact word membership is checked against both the compact base and delta.
    // Insert keys and their membership marker atomically so an interrupted retry
    // cannot mistake a partially written word for a complete one.
    const requested = [...words].map((word) => ({
      word,
      key: spellingKeys(word)[0],
      bucket: spellingBucket(spellingKeys(word)[0]),
    }));
    const novel = requested.length
      ? (
          await this.db
            .prepare(`WITH requested AS (
      SELECT json_extract(value,'$.word') AS word,json_extract(value,'$.key') AS key,json_extract(value,'$.bucket') AS bucket FROM json_each(?)
    ) SELECT r.word FROM requested r WHERE NOT EXISTS(SELECT 1 FROM archive_words w WHERE w.word=r.word)
      AND NOT EXISTS(SELECT 1 FROM archive_spelling_base b JOIN json_each(b.body, '$."'||r.key||'"') j WHERE b.bucket=r.bucket AND j.value=r.word)`)
            .bind(JSON.stringify(requested))
            .all<{ word: string }>()
        ).results
      : [];
    for (let i = 0; i < statements.length; i += 8)
      await this.db.batch(statements.slice(i, i + 8));
    for (let i = 0; i < novel.length; i += 20) {
      const group = novel.slice(i, i + 20).map((row) => row.word);
      const keys = group.flatMap((word) =>
        spellingKeys(word).map((key) => [key, word]),
      );
      const batch: ArchiveStatement[] = [];
      for (let j = 0; j < keys.length; j += 50) {
        const rows = keys.slice(j, j + 50);
        batch.push(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO archive_spelling_keys(key,word) VALUES ${rows.map(() => '(?,?)').join(',')}`,
            )
            .bind(...rows.flat()),
        );
      }
      batch.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO archive_words(word) VALUES ${group.map(() => '(?)').join(',')}`,
          )
          .bind(...group),
      );
      await this.db.batch(batch);
    }
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
    if (current?.search_version !== searchVersion)
      await this.db
        .prepare(
          'DELETE FROM archive_segments WHERE rowid IN (SELECT rowid FROM archive_segments WHERE shiur_id=? AND generation<? AND version<>? LIMIT 100)',
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
      const words = [
        ...new Set(
          normalizeTranscriptSearch(query)
            .split(' ')
            .filter((w) => w.length >= 3 && w.length <= 64),
        ),
      ];
      const requested = words.flatMap((word, slot) =>
        spellingKeys(word).map((key) => ({
          slot,
          bucket: spellingBucket(key),
          key,
        })),
      );
      if (requested.length) {
        const rows = await this.db
          .prepare(`WITH lookup AS (
          SELECT json_extract(value,'$.slot') AS slot,json_extract(value,'$.bucket') AS bucket,json_extract(value,'$.key') AS key FROM json_each(?)
        ), candidates AS (
          SELECT l.slot,k.word FROM lookup l JOIN archive_spelling_keys k ON k.key=l.key
          UNION SELECT l.slot,j.value AS word FROM lookup l JOIN archive_spelling_base b ON b.bucket=l.bucket JOIN json_each(b.body,'$."'||l.key||'"') j
        ), ranked AS (SELECT slot,word,ROW_NUMBER() OVER(PARTITION BY slot ORDER BY word) AS position FROM candidates)
        SELECT slot,word FROM ranked WHERE position<=128`)
          .bind(JSON.stringify(requested))
          .all<{ slot: number; word: string }>();
        for (const [slot, word] of words.entries())
          candidates.set(
            word,
            rows.results
              .filter(
                (row) => row.slot === slot && wordMatch(word, row.word) > 0,
              )
              .map((row) => row.word),
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
