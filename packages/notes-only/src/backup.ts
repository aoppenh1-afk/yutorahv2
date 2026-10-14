import { mkdir, readFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { NotesQueue } from './queue.js';
import {
  loadArtifact,
  durableWrite,
  statePath,
  syncDirectory,
  digest,
} from './artifacts.js';
/** Incremental work is derived from durable accepted-artifact state; --audit verifies every immutable copy. */
export async function backupArtifacts(
  root: string,
  destination: string,
  queue: NotesQueue,
  audit = false,
) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  queue.repairJournal();
  const rows = queue.db
    .prepare(
      `SELECT * FROM backup_journal ${audit ? '' : 'WHERE backed_up_at IS NULL'} ORDER BY path`,
    )
    .all();
  let copied = 0,
    verified = 0;
  for (const row of rows) {
    const path = String(row.path);
    const { note } = await loadArtifact(root, path);
    if (note.shiurId !== row.job_id || note.notesHash !== row.notes_hash)
      throw new Error('Backup journal identity mismatch.');
    const target = statePath(destination, path);
    const existing = await loadArtifact(destination, path).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      },
    );
    if (existing) {
      if (
        existing.note.notesHash !== note.notesHash ||
        digest(existing.note.gzip) !== digest(note.gzip)
      )
        throw new Error('Backup conflict.');
    } else {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = target + '.partial';
      // A partial copy is never a published backup. Its files can safely resume after a crash.
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      await durableWrite(join(temporary, 'notes.md.gz'), note.gzip);
      await durableWrite(
        join(temporary, 'manifest.json'),
        await readFile(join(statePath(root, path), 'manifest.json')),
      );
      await syncDirectory(temporary);
      await rename(temporary, target);
      await syncDirectory(dirname(target));
      await loadArtifact(destination, path);
      copied++;
    }
    queue.db
      .prepare(
        'UPDATE backup_journal SET backed_up_at=? WHERE path=? AND notes_hash=?',
      )
      .run(Date.now(), path, note.notesHash);
    verified++;
  }
  const status = {
    at: Date.now(),
    mode: audit ? 'full_audit' : 'incremental',
    copied,
    verified,
    pending: queue.db
      .prepare(
        'SELECT COUNT(*) AS count FROM backup_journal WHERE backed_up_at IS NULL',
      )
      .get()?.count,
  };
  await durableWrite(join(destination, 'status.json'), JSON.stringify(status));
  return status;
}
