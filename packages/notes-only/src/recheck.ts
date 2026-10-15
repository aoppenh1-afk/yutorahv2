import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { durableWrite } from './artifacts.js';
import { NotesQueue, type NoteJob } from './queue.js';
import { NotesPipeline } from './pipeline.js';

/** One paused, locked operation. Snapshots and immutable alternatives survive every checkpoint transition. */
export async function recheckSavedNotes(input: {
  root: string;
  queue: NotesQueue;
  pipeline: NotesPipeline;
  signal: AbortSignal;
}) {
  const { root, queue, pipeline, signal } = input;
  await access(join(root, 'paused'));
  if (
    queue.db
      .prepare('SELECT 1 FROM jobs WHERE lease_token IS NOT NULL LIMIT 1')
      .get() ||
    queue.db
      .prepare("SELECT 1 FROM sessions WHERE state!='deleted' LIMIT 1")
      .get() ||
    queue.db
      .prepare("SELECT 1 FROM requests WHERE status='active' LIMIT 1")
      .get()
  )
    throw new Error(
      'Pause and reconcile all inference before rechecking saved notes.',
    );
  const jobs = queue.db
    .prepare(
      "SELECT * FROM jobs WHERE priority>=3 AND (status='conflict' AND error='published_hash_conflict' OR status='needs_review' AND error='incomplete_output' AND artifact_path IS NULL) ORDER BY rowid",
    )
    .all() as NoteJob[];
  const directory = join(root, 'audits', 'saved-recheck-' + Date.now());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  queue.db.prepare('VACUUM INTO ?').run(join(directory, 'queue.sqlite'));
  await durableWrite(join(directory, 'before.json'), JSON.stringify(jobs));
  const results: { id: string; outcome: string }[] = [];
  for (const original of jobs) {
    signal.throwIfAborted();
    const owned = queue.db
      .prepare(
        "UPDATE jobs SET status='recovering',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status=? AND lease_token IS NULL RETURNING *",
      )
      .get(
        randomUUID(),
        Date.now() + 120000,
        Date.now(),
        original.id,
        original.status,
      ) as NoteJob | undefined;
    if (!owned) throw new Error('Saved checkpoint changed during recheck.');
    let outcome: string;
    try {
      outcome = await pipeline.recheckSaved(owned, signal);
    } catch (error) {
      if (queue.owns(owned))
        queue.finish(owned, { status: original.status, error: original.error });
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        outcome = 'missing_evidence';
      else if (
        [
          'source_changed',
          'language_source_unavailable',
          'invalid_transcript',
        ].includes(String((error as { code?: string }).code))
      )
        outcome = 'source_unverified';
      else throw error;
    }
    if (queue.owns(owned))
      queue.finish(owned, { status: original.status, error: original.error });
    results.push({ id: original.id, outcome });
    await durableWrite(
      join(directory, 'results.json'),
      JSON.stringify(results),
    );
  }
  return {
    examined: results.length,
    adopted: results.filter((x) => x.outcome === 'completed').length,
    revalidated: results.filter((x) => x.outcome === 'generated').length,
    remaining: results.filter(
      (x) => !['completed', 'generated'].includes(x.outcome),
    ).length,
    directory,
    results,
  };
}
