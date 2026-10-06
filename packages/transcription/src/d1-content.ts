import type { ArchiveDatabase, ArchiveObjects } from './archive.js';

/** Chunk sizes stay well below D1's 2 MB row limit, including UTF-8 text. */
export class D1ContentObjects implements ArchiveObjects {
  constructor(private db: ArchiveDatabase) {}
  async has(key: string) {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n,MIN(chunk_index) AS first,MAX(chunk_index) AS last,
      MIN(chunk_count) AS expected,MAX(chunk_count) AS largest FROM archive_content_chunks WHERE object_key=?`)
      .bind(key)
      .first<{
        n: number;
        first: number;
        last: number;
        expected: number;
        largest: number;
      }>();
    return (
      !!row &&
      row.n > 0 &&
      row.n === row.expected &&
      row.expected === row.largest &&
      row.first === 0 &&
      row.last === row.n - 1
    );
  }

  async put(key: string, body: string) {
    // Split UTF-16 without cutting a surrogate pair. JSON is reconstructed
    // verbatim, so its hash and transcript timestamps remain unchanged.
    const chunks: string[] = [];
    for (let start = 0; start < body.length;) {
      let end = Math.min(start + 100_000, body.length);
      if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end--;
      chunks.push(body.slice(start, end));
      start = end;
    }
    if (!chunks.length) throw new Error('Invalid empty content.');
    // Immutable objects survive notes updates and interrupted publication.
    // Check only chunk metadata instead of uploading the same text again.
    const existing = await this.db
      .prepare(
        'SELECT chunk_index,chunk_count FROM archive_content_chunks WHERE object_key=?',
      )
      .bind(key)
      .all<{ chunk_index: number; chunk_count: number }>();
    const staged = new Set(
      existing.results
        .filter((row) => row.chunk_count === chunks.length)
        .map((row) => row.chunk_index),
    );
    const statements = chunks.flatMap((chunk, index) =>
      staged.has(index)
        ? []
        : [
            this.db
              .prepare(
                `INSERT OR IGNORE INTO archive_content_chunks(object_key,chunk_index,chunk_count,body)
       VALUES(?,?,?,?)`,
              )
              .bind(key, index, chunks.length, chunk),
          ],
    );
    for (let i = 0; i < statements.length; i += 20)
      await this.db.batch(statements.slice(i, i + 20));
  }

  async get(key: string) {
    const { results } = await this.db
      .prepare(
        'SELECT chunk_index,chunk_count,body FROM archive_content_chunks WHERE object_key=? ORDER BY chunk_index',
      )
      .bind(key)
      .all<{ chunk_index: number; chunk_count: number; body: string }>();
    if (!results.length) return null;
    if (
      results.length !== results[0].chunk_count ||
      results.some(
        (r, i) => r.chunk_index !== i || r.chunk_count !== results.length,
      )
    )
      throw new Error('Published content is incomplete.');
    return { text: async () => results.map((r) => r.body).join('') };
  }
}
