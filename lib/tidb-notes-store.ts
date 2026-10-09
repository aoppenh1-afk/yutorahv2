import { connect } from '@tidbcloud/serverless';

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
      'SELECT shiur_id, source_sha256, notes_sha256, generator_version, language, raw_bytes, created_at_ms, notes_gzip FROM shiur_notes WHERE shiur_id = ?',
      [id],
    );
    const row = rows[0];
    if (!row) return null;
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
  /** An insert-only writer cannot replace published notes on a stale retry. */
  async publish(note: SavedNote) {
    await unpackNote(note);
    const binary = (value: string) =>
      Uint8Array.from(value.match(/../g)!, (x) => parseInt(x, 16));
    try {
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
      const saved = await this.get(note.shiurId).catch(() => null);
      if (!saved) throw error;
      if (
        saved.sourceHash !== note.sourceHash ||
        saved.notesHash !== note.notesHash ||
        saved.generatorVersion !== note.generatorVersion
      )
        throw new Error(
          'Published notes conflict; explicit replacement is required.',
        );
    }
    const saved = await this.get(note.shiurId);
    if (
      !saved ||
      saved.sourceHash !== note.sourceHash ||
      saved.notesHash !== note.notesHash ||
      saved.generatorVersion !== note.generatorVersion ||
      (await unpackNote(saved)) !== (await unpackNote(note))
    )
      throw new Error('Notes publication was not confirmed.');
  }
}
