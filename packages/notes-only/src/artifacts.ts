import { mkdir, readFile, rename, open, rm, readdir } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  notesHash,
  unpackNote,
  type SavedNote,
} from '../../../lib/tidb-notes-store.js';
import type { NotesQueue } from './queue.js';

export const digest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export async function syncDirectory(path: string) {
  const fd = await open(path, 'r');
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export async function durableWrite(path: string, data: string | Uint8Array) {
  const temporary = path + '.' + randomUUID() + '.next';
  const fd = await open(temporary, 'wx', 0o600);
  try {
    await fd.writeFile(data);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}
export function statePath(root: string, path: string) {
  const result = resolve(root, path);
  const part = relative(root, result);
  if (!part || part.startsWith('..') || part.startsWith('/'))
    throw new Error('Invalid artifact path.');
  return result;
}
async function syncParents(root: string, path: string) {
  let current = path;
  while (current.startsWith(root)) {
    await syncDirectory(current);
    if (current === root) break;
    current = dirname(current);
  }
}
export type ArtifactManifest = {
  version: 2;
  note: Omit<SavedNote, 'gzip'>;
  gzipHash: string;
  gzipBytes: number;
  profile: string;
  generator: string;
  route: string;
  review: string;
  attempt: string;
};
export async function saveArtifact(
  root: string,
  path: string,
  note: SavedNote,
  identity: Pick<
    ArtifactManifest,
    'profile' | 'generator' | 'route' | 'review' | 'attempt'
  >,
) {
  await unpackNote(note);
  if (
    !/^[A-Za-z0-9._-]{1,128}$/.test(note.generatorVersion) ||
    !/^\d{1,12}$/.test(note.shiurId)
  )
    throw new Error('Invalid artifact identity.');
  const target = statePath(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + '.' + randomUUID() + '.partial';
  await mkdir(temporary, { mode: 0o700 });
  const { gzip, ...metadata } = note;
  const manifest: ArtifactManifest = {
    version: 2,
    note: metadata,
    gzipHash: digest(gzip),
    gzipBytes: gzip.length,
    ...identity,
  };
  try {
    await durableWrite(join(temporary, 'notes.md.gz'), gzip);
    await durableWrite(
      join(temporary, 'manifest.json'),
      JSON.stringify(manifest),
    );
    await syncDirectory(temporary);
    // Each attempt has a unique target. A committed directory is never modified.
    await rename(temporary, target);
    await syncParents(root, dirname(target));
  } catch (e) {
    await rm(temporary, { recursive: true, force: true });
    throw e;
  }
  return manifest;
}
export async function loadArtifact(
  root: string,
  path: string,
): Promise<{ note: SavedNote; manifest: ArtifactManifest }> {
  const folder = statePath(root, path);
  const manifest = JSON.parse(
    await readFile(join(folder, 'manifest.json'), 'utf8'),
  ) as ArtifactManifest;
  const gzip = new Uint8Array(await readFile(join(folder, 'notes.md.gz')));
  if (
    manifest.version !== 2 ||
    digest(gzip) !== manifest.gzipHash ||
    gzip.length !== manifest.gzipBytes
  )
    throw new Error('Artifact manifest mismatch.');
  const note = { ...manifest.note, gzip };
  await unpackNote(note);
  return { note, manifest };
}
export async function pinSource(root: string, id: string, vtt: string) {
  const hash = await notesHash(new TextEncoder().encode(vtt));
  const path = join('sources', id, hash + '.vtt');
  const target = statePath(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const existing = await readFile(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (existing && digest(existing) !== hash)
    throw new Error('Pinned source is corrupt.');
  if (!existing) {
    await durableWrite(target, vtt);
    await syncParents(root, dirname(target));
  }
  return { path, hash, bytes: Buffer.byteLength(vtt) };
}
/** Import provenance without changing published bytes or legacy attempt counters. Idempotent. */
export async function importLegacy(root: string, queue: NotesQueue) {
  // A user-requested regeneration must never re-adopt the retired notes on reinstall.
  if (queue.cursor('regenerationStartedAt') > 1) return 0;
  let imported = 0;
  for (const id of await readdir(join(root, 'notes')).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    },
  )) {
    if (!/^[1-9]\d{0,11}$/.test(id)) continue;
    const row = queue.db
      .prepare('SELECT status,notes_hash,artifact_path FROM jobs WHERE id=?')
      .get(id);
    if (row?.artifact_path) continue;
    const folder = join(root, 'notes', id);
    const text = await readFile(join(folder, 'metadata.json'), 'utf8').catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      },
    );
    if (!text) continue;
    const note: SavedNote = {
      ...JSON.parse(text),
      gzip: new Uint8Array(await readFile(join(folder, 'notes.md.gz'))),
    };
    if (note.shiurId !== id) throw new Error('Legacy note ID mismatch.');
    await unpackNote(note);
    if (row?.status === 'completed' && row.notes_hash !== note.notesHash)
      throw new Error('Legacy completion hash mismatch.');
    const path = join(
      'artifacts',
      id,
      note.sourceHash,
      note.generatorVersion,
      'legacy-' + note.notesHash,
    );
    // Reject unsafe provenance before it can become a path component.
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(note.generatorVersion) ||
      !/^[a-f0-9]{64}$/.test(note.sourceHash)
    )
      throw new Error('Invalid legacy identity.');
    await loadArtifact(root, path).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return saveArtifact(root, path, note, {
        profile: note.generatorVersion,
        generator: JSON.stringify({
          provenance: 'legacy',
          profile: note.generatorVersion,
        }),
        route: 'acp-high',
        review: 'approved_route',
        attempt: 'legacy',
      });
    });
    queue.transaction(() => {
      if (!row)
        queue.db
          .prepare(
            "INSERT INTO jobs(id,title,teacher,status) VALUES(?,?,?,'completed')",
          )
          .run(id, `Shiur ${id}`, '');
      queue.db
        .prepare(`UPDATE jobs SET artifact_path=?,artifact_bytes=?,source_hash=?,notes_hash=?,profile=?,
        generator=?,review='approved_route',eligibility='eligible',status=CASE WHEN status='completed' THEN status ELSE 'generated' END,
        lease_token=NULL,lease_until=0 WHERE id=? AND artifact_path IS NULL`)
        .run(
          path,
          note.gzip.length + 8192,
          note.sourceHash,
          note.notesHash,
          note.generatorVersion,
          JSON.stringify({
            provenance: 'legacy',
            profile: note.generatorVersion,
          }),
          id,
        );
      queue.journal(id, path, note.notesHash);
    });
    imported++;
  }
  queue.repairJournal();
  return imported;
}
