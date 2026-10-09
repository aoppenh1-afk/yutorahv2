import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const state = resolve(process.argv[2]);
const logPath = process.argv[3] ?? join(state, 'logs/pool-verification.log');
const events = (await readFile(logPath, 'utf8'))
  .trim()
  .split('\n')
  .map(JSON.parse);
const starts = events.filter((event) => event.status === 'started');
const generations = events.filter((event) => event.status === 'generating');
assert.equal(Math.max(...starts.map((event) => event.active)), 6);
assert.ok(starts.length > 6, 'Pilot must exercise replacement jobs.');
assert.equal(new Set(starts.map((event) => event.id)).size, starts.length);
assert.ok(
  starts.slice(6).some((event) => event.active > 1),
  'Free slots must refill while other jobs remain active.',
);
assert.ok(
  events.every((event) => event.active === undefined || event.active <= 6),
);
assert.ok(generations.length >= 6, 'Pilot must generate at least six notes.');
assert.ok(
  generations.every(
    (event) =>
      event.model === 'opencode/muse-spark-1.3-contributor-free' &&
      event.thinking === 'high',
  ),
);
assert.ok(!events.some((event) => ['retry', 'blocked'].includes(event.status)));

const temporary = await mkdtemp(join(state, '.pool-verification-'));
try {
  const source = await readFile(join(state, 'app/notes-pipeline.mjs'), 'utf8');
  const modulePath = join(temporary, 'modules.mjs');
  await writeFile(
    modulePath,
    source.slice(0, source.lastIndexOf('// apps/notes-only/src/cli.ts')) +
      '\nexport {NotesQueue, TiDBNotesStore, unpackNote};\n',
    { mode: 0o600 },
  );
  const { NotesQueue, TiDBNotesStore, unpackNote } = await import(
    pathToFileURL(modulePath).href
  );
  const store = new TiDBNotesStore(
    JSON.parse(await readFile(join(state, 'writer.json'), 'utf8')),
  );
  const queue = new NotesQueue(join(state, 'queue.sqlite'));
  const notes = [];
  try {
    for (const { id } of starts) {
      const row = queue.db
        .prepare('SELECT status,notes_hash FROM jobs WHERE id=?')
        .get(id);
      assert.ok(['completed', 'missing'].includes(row.status));
      if (row.status === 'missing') continue;
      const metadata = JSON.parse(
        await readFile(join(state, 'notes', id, 'metadata.json'), 'utf8'),
      );
      const gzip = new Uint8Array(
        await readFile(join(state, 'notes', id, 'notes.md.gz')),
      );
      const published = await store.get(id);
      assert.ok(published);
      assert.equal(published.generatorVersion, metadata.generatorVersion);
      assert.equal(published.notesHash, metadata.notesHash);
      assert.equal(row.notes_hash, metadata.notesHash);
      assert.equal(
        await unpackNote(published),
        await unpackNote({ ...metadata, gzip }),
      );
      await assert.rejects(readFile(join(state, 'jobs', id, 'source.vtt')), {
        code: 'ENOENT',
      });
      notes.push({
        id,
        databaseReadback: true,
        checkpoint: 'completed',
        temporarySourceDeleted: true,
      });
    }
  } finally {
    queue.close();
  }
  const result = {
    verifiedAt: new Date().toISOString(),
    maxConcurrentJobs: 6,
    model: 'opencode/muse-spark-1.3-contributor-free',
    thinking: 'high',
    automaticRefill: true,
    jobs: starts.length,
    published: notes.length,
    notes,
  };
  await writeFile(
    join(state, 'pool-verification.json'),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
