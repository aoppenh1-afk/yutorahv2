import type { SearchDatabase, SearchStatement } from './search-storage';
import type { Shiur } from './yutorah';
import { notesBlocks } from './notes-document';
import { stripNotesDirectionControls } from './notes-direction';
import { searchText } from './search-matching';
import { unpackNote, type SavedNote } from './tidb-notes-store';
import { NOTES_SNAPSHOT_LIFETIME } from './notes-search';

export type NoteHeader = { id: string; hash: string };
export type NotesIndexSource = {
  headersAfter: (after: number, limit: number) => Promise<NoteHeader[]>;
  get: (id: string) => Promise<SavedNote | null>;
};
type Sync = { snapshot: string; cursor: number; owner: string; lease: number };
const leaseMs = 180_000;
// The PostgreSQL adapter translates this to clock_timestamp(), not transaction now().
const databaseClock = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const keyFor = (id: string, hash: string) => `${id}:${hash}:1`;

/** Keep original readable text for excerpts, and the shared normalized words for FTS. */
export async function noteSearchDocument(note: SavedNote, shiur: Shiur) {
  if (shiur.id !== Number(note.shiurId) || !shiur.title.trim())
    throw new Error('The note metadata does not match its shiur.');
  const markdown = await unpackNote(note);
  const text = stripNotesDirectionControls(
    notesBlocks(markdown)
      .map((block) => block.runs.map((run) => run.text).join(''))
      .join('\n\n'),
  );
  const normalized = searchText(text);
  const payload = JSON.stringify(shiur);
  if (
    !normalized ||
    new TextEncoder().encode(text + normalized + payload).length > 1_900_000
  )
    throw new Error(
      'This note cannot be indexed within the supported document size.',
    );
  return {
    key: keyFor(note.shiurId, note.notesHash),
    id: shiur.id,
    hash: note.notesHash,
    text,
    normalized,
    payload,
  };
}

/** One durable, bounded page. Interrupted scans resume; readers retain the prior inventory. */
export async function syncNotesPage(
  db: SearchDatabase,
  source: NotesIndexSource,
  metadata: (id: string) => Promise<Shiur>,
  options: { batch?: number; clock?: () => number } = {},
) {
  const batch = options.batch ?? 10;
  if (!Number.isInteger(batch) || batch < 1 || batch > 20)
    throw new RangeError('Choose a notes batch size between 1 and 20.');
  const now = options.clock ?? Date.now;
  const owner = crypto.randomUUID();
  await db
    .prepare(
      "INSERT OR IGNORE INTO search_notes_state(name,snapshot,cursor,owner,lease,updated) VALUES('sync',?,0,'',0,?)",
    )
    .bind(crypto.randomUUID(), now())
    .run();
  const acquired = await db
    .prepare(
      "UPDATE search_notes_state SET owner=?,lease=?,updated=? WHERE name='sync' AND lease<?",
    )
    .bind(owner, now() + leaseMs, now(), now())
    .run();
  if (!acquired.meta.changes)
    return { complete: false, busy: true, indexed: 0 };
  const state = (await db
    .prepare(
      "SELECT snapshot,cursor,owner,lease FROM search_notes_state WHERE name='sync' AND owner=?",
    )
    .bind(owner)
    .first<Sync>())!;
  if (!state) throw new Error('The notes indexing lease was lost.');
  try {
    await db
      .prepare(
        'INSERT OR IGNORE INTO search_note_snapshots(id,created) VALUES(?,?)',
      )
      .bind(state.snapshot, now())
      .run();
    const headers = await source.headersAfter(state.cursor, batch);
    let cursor = state.cursor;
    if (headers.length > batch)
      throw new Error('The notes inventory exceeded its page limit.');
    for (const header of headers) {
      const id = Number(header.id);
      if (
        !/^[1-9]\d{0,11}$/.test(header.id) ||
        !Number.isSafeInteger(id) ||
        id <= cursor ||
        !/^[a-f0-9]{64}$/.test(header.hash)
      )
        throw new Error(
          'The notes inventory changed or returned an invalid page.',
        );
      cursor = id;
    }
    const statements: SearchStatement[] = [
      // Lock the coordination row before checking ownership. A late peer cannot
      // replace the lease between the guard and publication of this transaction.
      db
        .prepare(
          "UPDATE search_notes_state SET owner=owner WHERE name='sync' AND owner=?",
        )
        .bind(owner),
      db
        .prepare(`INSERT INTO search_notes_guards(owner,valid) VALUES(?,CASE WHEN EXISTS(
        SELECT 1 FROM search_notes_state WHERE name='sync' AND owner=? AND snapshot=? AND cursor=? AND lease>=? AND lease>=${databaseClock}
      ) THEN 1 ELSE 0 END)`)
        .bind(owner, owner, state.snapshot, state.cursor, now()),
    ];
    // Source bodies and metadata are fetched only for new hashes, outside transactions.
    // A small pool bounds memory and network pressure even for maximum-size notes.
    let next = 0;
    const prepared = Array.from(
      { length: headers.length },
      () => [] as SearchStatement[],
    );
    const keys = headers.map((header) => keyFor(header.id, header.hash));
    const existingKeys = new Set(
      keys.length
        ? (
            await db
              .prepare(
                `SELECT key FROM search_note_documents WHERE key IN (${keys.map(() => '?').join(',')})`,
              )
              .bind(...keys)
              .all<{ key: string }>()
          ).results.map((row) => row.key)
        : [],
    );
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(3, headers.length) }, async () => {
        for (;;) {
          const slot = next++;
          if (slot >= headers.length) break;
          const header = headers[slot];
          const key = keyFor(header.id, header.hash);
          const group: SearchStatement[] = [];
          if (!existingKeys.has(key)) {
            const note = await source.get(header.id);
            if (
              !note ||
              note.shiurId !== header.id ||
              note.notesHash !== header.hash
            )
              throw new Error(
                'A published note changed during indexing. Retry this page.',
              );
            const doc = await noteSearchDocument(
              note,
              await metadata(header.id),
            );
            group.push(
              db
                .prepare(
                  'INSERT OR IGNORE INTO search_note_documents(key,id,notes_hash,payload,text,normalized) VALUES(?,?,?,?,?,?)',
                )
                .bind(
                  doc.key,
                  doc.id,
                  doc.hash,
                  doc.payload,
                  doc.text,
                  doc.normalized,
                ),
            );
          }
          group.push(
            db
              .prepare(
                'INSERT INTO search_note_members(snapshot,id,key) VALUES(?,?,?) ON CONFLICT(snapshot,id) DO UPDATE SET key=excluded.key',
              )
              .bind(state.snapshot, Number(header.id), key),
          );
          prepared[slot] = group;
        }
      }),
    );
    const failed = workers.find((worker) => worker.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    statements.push(...prepared.flat());
    // Re-evaluate expiration after network I/O, rather than using the pre-fetch time.
    statements.push(
      db
        .prepare(`UPDATE search_notes_guards SET valid=CASE WHEN EXISTS(
      SELECT 1 FROM search_notes_state WHERE name='sync' AND owner=? AND snapshot=? AND lease>=? AND lease>=${databaseClock}
    ) THEN 1 ELSE 0 END WHERE owner=?`)
        .bind(owner, state.snapshot, now(), owner),
    );
    const complete = headers.length === 0;
    if (complete) {
      statements.push(
        db
          .prepare(
            'UPDATE search_note_snapshots SET completed=?,count=(SELECT COUNT(*) FROM search_note_members WHERE snapshot=?) WHERE id=?',
          )
          .bind(now(), state.snapshot, state.snapshot),
        db
          .prepare(
            "INSERT INTO search_notes_state(name,snapshot,updated) VALUES('active',?,?) ON CONFLICT(name) DO UPDATE SET snapshot=excluded.snapshot,updated=excluded.updated",
          )
          .bind(state.snapshot, now()),
        db
          .prepare(
            "DELETE FROM search_notes_state WHERE name='sync' AND owner=?",
          )
          .bind(owner),
      );
    } else
      statements.push(
        db
          .prepare(
            "UPDATE search_notes_state SET cursor=?,lease=0,updated=? WHERE name='sync' AND owner=?",
          )
          .bind(cursor, now(), owner),
      );
    statements.push(
      db.prepare('DELETE FROM search_notes_guards WHERE owner=?').bind(owner),
    );
    await db.batch(statements);
    return {
      complete,
      busy: false,
      indexed: headers.length,
      snapshot: state.snapshot,
      cursor,
    };
  } finally {
    await db
      .prepare(
        "UPDATE search_notes_state SET lease=0 WHERE name='sync' AND owner=?",
      )
      .bind(owner)
      .run();
  }
}

/** Keep the active and preceding inventory; bound duplicate memberships and orphan versions. */
export async function cleanNotesIndex(db: SearchDatabase, now = Date.now()) {
  await db
    .prepare(`DELETE FROM search_note_snapshots WHERE completed>0
    AND id NOT IN (SELECT snapshot FROM search_notes_state)
    AND (completed<? OR id NOT IN (
      SELECT id FROM search_note_snapshots WHERE completed>0
      AND id NOT IN (SELECT snapshot FROM search_notes_state WHERE name='active')
      ORDER BY completed DESC,created DESC,id DESC LIMIT 1
    ))`)
    .bind(now - NOTES_SNAPSHOT_LIFETIME)
    .run();
  return db
    .prepare(`DELETE FROM search_note_documents WHERE key IN (
    SELECT d.key FROM search_note_documents d WHERE NOT EXISTS(SELECT 1 FROM search_note_members m WHERE m.key=d.key) LIMIT 100
  )`)
    .run();
}
