import { connect, type Row } from '@tidbcloud/serverless';

export const notesLimits = { raw: 1024 * 1024, compressed: 256 * 1024 };
export type NotesCredential = {
  host: string;
  username: string;
  password: string;
  database: string;
};
export type SavedNote = {
  shiurId: string;
  sourceHash: string;
  notesHash: string;
  generatorVersion: string;
  language: string;
  rawBytes: number;
  createdAtMs: number;
  gzip: Uint8Array;
};
export type NoteMetadata = Omit<SavedNote, 'gzip'>;
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export async function notesHash(bytes: Uint8Array) {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
  );
}
export async function streamBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Content exceeds the byte limit.');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function packNote(input: {
  shiurId: string;
  sourceHash: string;
  generatorVersion: string;
  language: string;
  markdown: string;
}): Promise<SavedNote> {
  if (
    !/^[1-9]\d{0,11}$/.test(input.shiurId) ||
    !/^[a-f0-9]{64}$/.test(input.sourceHash) ||
    !input.markdown.trim() ||
    input.generatorVersion.length > 128 ||
    input.language.length > 16
  )
    throw new Error('Invalid note.');
  const raw = new TextEncoder().encode(input.markdown);
  if (raw.length > notesLimits.raw) throw new Error('Notes are too large.');
  const gzip = await streamBytes(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')),
    notesLimits.compressed,
  );
  return {
    shiurId: input.shiurId,
    sourceHash: input.sourceHash,
    generatorVersion: input.generatorVersion,
    language: input.language,
    rawBytes: raw.length,
    notesHash: await notesHash(raw),
    createdAtMs: Date.now(),
    gzip,
  };
}
export async function unpackNote(note: SavedNote) {
  if (
    note.gzip.length > notesLimits.compressed ||
    note.rawBytes > notesLimits.raw ||
    note.rawBytes < 1
  )
    throw new Error('Invalid note size.');
  const bytes = await streamBytes(
    new Blob([new Uint8Array(note.gzip)])
      .stream()
      .pipeThrough(new DecompressionStream('gzip')),
    notesLimits.raw,
  );
  if (
    bytes.length !== note.rawBytes ||
    (await notesHash(bytes)) !== note.notesHash
  )
    throw new Error('Notes checksum mismatch.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const noteColumns =
  'shiur_id, source_sha256, notes_sha256, generator_version, language, raw_bytes, created_at_ms, notes_gzip';
function savedNote(row: Row): SavedNote {
  if (Array.isArray(row)) throw new Error('Unexpected database row format.');
  return {
    shiurId: String(row.shiur_id),
    sourceHash: hex(row.source_sha256),
    notesHash: hex(row.notes_sha256),
    generatorVersion: row.generator_version,
    language: row.language,
    rawBytes: Number(row.raw_bytes),
    createdAtMs: Number(row.created_at_ms),
    gzip: row.notes_gzip,
  };
}
export class TiDBNotesStore {
  private db;
  constructor(credential: NotesCredential) {
    if (
      !/^gateway\d*\.[a-z0-9-]+\.prod\.(?:aws|gcp)\.tidbcloud\.com$/.test(
        credential.host,
      ) ||
      !credential.username ||
      !credential.password ||
      !/^[a-z][a-z0-9_]*$/.test(credential.database)
    )
      throw new Error('Invalid TiDB notes credentials.');
    this.db = connect({
      ...credential,
      fetch: (url, init) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
    });
  }
  async get(id: string): Promise<SavedNote | null> {
    if (!/^[1-9]\d{0,11}$/.test(id)) throw new Error('Invalid shiur.');
    const rows = await this.db.execute(
      `SELECT ${noteColumns} FROM shiur_notes WHERE shiur_id = ?`,
      [id],
    );
    const row = rows[0];
    return row ? savedNote(row) : null;
  }
  async getMany(ids: string[]): Promise<SavedNote[]> {
    if (!ids.length) return [];
    if (ids.length > 100 || !ids.every((id) => /^[1-9]\d{0,11}$/.test(id)))
      throw new Error('Invalid shiur.');
    const rows = await this.db.execute(
      `SELECT ${noteColumns} FROM shiur_notes WHERE shiur_id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    return rows.map(savedNote);
  }
  async oldestShiurId(): Promise<number> {
    const rows = await this.db.execute(
      'SELECT MIN(shiur_id) AS oldest FROM shiur_notes',
    );
    const row = rows[0];
    return row && !Array.isArray(row) ? Number(row.oldest) || 0 : 0;
  }
  /** Keyset pagination inventories every canonical note without downloading all blobs. */
  async listMetadata(afterId = '0', limit = 200): Promise<NoteMetadata[]> {
    if (
      !/^\d{1,12}$/.test(afterId) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new Error('Invalid notes inventory bounds.');
    const rows = await this.db.execute(
      'SELECT shiur_id, source_sha256, notes_sha256, generator_version, language, raw_bytes, created_at_ms FROM shiur_notes WHERE shiur_id > ? ORDER BY shiur_id LIMIT ?',
      [afterId, limit],
    );
    return rows.map((row) => {
      if (Array.isArray(row))
        throw new Error('Unexpected database row format.');
      return {
        shiurId: String(row.shiur_id),
        sourceHash: hex(row.source_sha256),
        notesHash: hex(row.notes_sha256),
        generatorVersion: row.generator_version,
        language: row.language,
        rawBytes: Number(row.raw_bytes),
        createdAtMs: Number(row.created_at_ms),
      };
    });
  }
  /** A zero-row probe checks replacement rights without changing a published note. */
  async verifyReplacementPermission() {
    await this.db.execute(
      'UPDATE shiur_notes SET source_sha256=source_sha256, notes_sha256=notes_sha256, generator_version=generator_version, language=language, raw_bytes=raw_bytes, created_at_ms=created_at_ms, notes_gzip=notes_gzip WHERE shiur_id=0',
    );
  }
  /** First verified publication wins; return the canonical note on stale retries. */
  async publish(note: SavedNote, replaceHash?: string | null) {
    await unpackNote(note);
    const binary = (value: string) =>
      Uint8Array.from(value.match(/../g)!, (x) => parseInt(x, 16));
    let saved: SavedNote | null | undefined;
    try {
      if (replaceHash) {
        if (!/^[a-f0-9]{64}$/.test(replaceHash))
          throw new Error('Invalid replacement hash.');
        // Compare-and-swap preserves the old row until a complete replacement is ready.
        await this.db.execute(
          'UPDATE shiur_notes SET source_sha256=?, notes_sha256=?, generator_version=?, language=?, raw_bytes=?, created_at_ms=?, notes_gzip=? WHERE shiur_id=? AND notes_sha256=?',
          [
            binary(note.sourceHash),
            binary(note.notesHash),
            note.generatorVersion,
            note.language,
            note.rawBytes,
            note.createdAtMs,
            note.gzip,
            note.shiurId,
            binary(replaceHash),
          ],
        );
      } else
        await this.db.execute(
          'INSERT INTO shiur_notes (shiur_id, source_sha256, notes_sha256, generator_version, language, raw_bytes, created_at_ms, notes_gzip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            note.shiurId,
            binary(note.sourceHash),
            binary(note.notesHash),
            note.generatorVersion,
            note.language,
            note.rawBytes,
            note.createdAtMs,
            note.gzip,
          ],
        );
    } catch (error) {
      // Resolve duplicate inserts and lost acknowledgements by reading durable state.
      saved = await this.get(note.shiurId).catch(() => null);
      if (!saved) throw error;
      if (
        replaceHash &&
        saved.notesHash === replaceHash &&
        (saved.notesHash !== note.notesHash ||
          saved.generatorVersion !== note.generatorVersion ||
          saved.sourceHash !== note.sourceHash)
      )
        throw error;
    }
    saved ??= await this.get(note.shiurId);
    if (!saved || saved.shiurId !== note.shiurId)
      throw new Error('Notes publication was not confirmed.');
    await unpackNote(saved);
    return saved;
  }
}
