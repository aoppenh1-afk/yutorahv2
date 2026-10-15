import type { SearchDatabase } from './search-storage';
import { decodeSearchDocument } from './notes-search-document';
import type { NotesSearchResult } from './notes-search-types';
import { searchText, matchExcerpt } from './search-discovery';

export const NOTES_SNAPSHOT_LIFETIME = 24 * 60 * 60_000;
export class NotesSearchError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}
export type NotesSnapshot = { id: string; completed: number; count: number };

/** Only completed inventories are public. Pagination keeps the same inventory. */
export async function notesSnapshot(db: SearchDatabase, id = '') {
  if (id && !/^[a-f0-9-]{36}$/.test(id))
    throw new NotesSearchError('Start a new search for written notes.', 400);
  let row: NotesSnapshot | null;
  try {
    row = await db
      .prepare(
        id
          ? 'SELECT id,completed,count FROM search_note_snapshots WHERE id=? AND completed>0'
          : "SELECT s.id,s.completed,s.count FROM search_note_snapshots s JOIN search_notes_state a ON a.snapshot=s.id WHERE a.name='active' AND s.completed>0",
      )
      .bind(...(id ? [id] : []))
      .first<NotesSnapshot>();
  } catch {
    throw new NotesSearchError(
      'Written notes search is temporarily unavailable. Please try again.',
    );
  }
  if (!row || row.completed < Date.now() - NOTES_SNAPSHOT_LIFETIME)
    throw new NotesSearchError(
      id
        ? 'These notes results have expired. Start the search again.'
        : 'Written notes search is being refreshed. Please try again later.',
      id ? 409 : 503,
    );
  return { ...row, completed: Number(row.completed), count: Number(row.count) };
}

export function notesSearchQuery(query: string, mode: 'terms' | 'phrase') {
  if (query.length > 200)
    throw new RangeError('Use up to 200 characters to search notes.');
  const words = searchText(query).split(' ').filter(Boolean);
  if (
    !words.length ||
    words.length > 16 ||
    words.some((word) => word.length > 64)
  )
    throw new RangeError('Enter up to sixteen search words.');
  return {
    sqlite:
      mode === 'phrase'
        ? `"${words.join(' ')}"`
        : [...new Set(words)].map((word) => `"${word}"`).join(' AND '),
    postgres: words
      .map((word) => `'${word}'`)
      .join(mode === 'phrase' ? ' <-> ' : ' & '),
  };
}

/** The database inverted index finds matches; only one bounded page of text is read. */
export async function searchNotes(
  db: SearchDatabase,
  query: string,
  options: {
    mode?: 'terms' | 'phrase';
    page?: number;
    snapshot?: string;
  } = {},
): Promise<NotesSearchResult> {
  const compiled = notesSearchQuery(query, options.mode || 'terms');
  const page = options.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 50_000)
    throw new RangeError('Choose a valid notes results page.');
  const snapshot = await notesSnapshot(db, options.snapshot);
  const postgres = db.dialect === 'postgres';
  const from = postgres
    ? "search_note_documents n JOIN search_note_members m ON m.key=n.key WHERE m.snapshot=? AND to_tsvector('simple',n.normalized) @@ to_tsquery('simple',?)"
    : 'search_note_fulltext JOIN search_note_documents n ON n.rowid=search_note_fulltext.rowid JOIN search_note_members m ON m.key=n.key WHERE m.snapshot=? AND search_note_fulltext MATCH ?';
  const params = [snapshot.id, postgres ? compiled.postgres : compiled.sqlite];
  const total = Number(
    (await db
      .prepare(`SELECT COUNT(*) AS count FROM ${from}`)
      .bind(...params)
      .first<{ count: number }>())!.count,
  );
  const order = postgres
    ? "ts_rank_cd(to_tsvector('simple',n.normalized),to_tsquery('simple',?),32) DESC,n.id DESC"
    : // FTS5 BM25 uses corpus-wide frequencies, which change while a successor
      // inventory is being built. Use a document-local order for stable pages.
      "CASE WHEN instr(' ' || n.normalized || ' ',?)>0 THEN 0 ELSE 1 END,LENGTH(n.normalized),n.id DESC";
  const pageSize = 10;
  const { results } = await db
    .prepare(
      `SELECT n.payload,n.text,n.notes_hash FROM ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .bind(
      ...params,
      postgres ? compiled.postgres : ` ${searchText(query)} `,
      pageSize,
      (page - 1) * pageSize,
    )
    .all<{ payload: string; text: string; notes_hash: string }>();
  return {
    items: await Promise.all(
      results.map(async (row) => {
        const { shiur, text } = await decodeSearchDocument(
          row.payload,
          row.text,
        );
        return {
          shiur,
          notesHash: row.notes_hash,
          excerpt: matchExcerpt(text, query, 280),
          href: `/?shiur=${shiur.id}`,
        };
      }),
    ),
    total,
    nextPage: page * pageSize < total ? page + 1 : null,
    snapshot: snapshot.id,
    updatedAt: snapshot.completed,
  };
}
