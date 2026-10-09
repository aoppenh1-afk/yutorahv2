import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const state = resolve(process.argv[2]);
const events = (await readFile(join(state, 'logs/worker.log'), 'utf8'))
  .trim()
  .split('\n')
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const id =
  process.argv[3] ??
  events.findLast(
    (event) =>
      event.status === 'completed' &&
      events.some(
        (request) =>
          request.id === event.id &&
          request.status === 'generating' &&
          request.thinking === 'high',
      ),
  )?.id;
assert.match(id ?? '', /^[1-9]\d{0,11}$/);
assert.ok(
  events.some(
    (event) =>
      event.id === id &&
      event.status === 'generating' &&
      event.model === 'opencode/muse-spark-1.3-contributor-free' &&
      event.thinking === 'high',
  ),
);
assert.ok(
  events.some((event) => event.id === id && event.status === 'completed'),
);

const temporary = await mkdtemp(join(state, '.note-verification-'));
try {
  const source = await readFile(join(state, 'app/notes-pipeline.mjs'), 'utf8');
  const modulePath = join(temporary, 'modules.mjs');
  await writeFile(
    modulePath,
    source.slice(0, source.lastIndexOf('// apps/notes-only/src/cli.ts')) +
      '\nexport { NotesQueue, TiDBNotesStore, unpackNote };\n',
    { mode: 0o600 },
  );
  const { NotesQueue, TiDBNotesStore, unpackNote } = await import(
    pathToFileURL(modulePath).href
  );
  const store = new TiDBNotesStore(
    JSON.parse(await readFile(join(state, 'writer.json'), 'utf8')),
  );
  const metadata = JSON.parse(
    await readFile(join(state, 'notes', id, 'metadata.json'), 'utf8'),
  );
  const gzip = new Uint8Array(
    await readFile(join(state, 'notes', id, 'notes.md.gz')),
  );
  const published = await store.get(id);
  assert.ok(published, 'Generated note must be readable from TiDB.');
  for (const field of [
    'shiurId',
    'sourceHash',
    'notesHash',
    'generatorVersion',
    'language',
    'rawBytes',
  ])
    assert.equal(published[field], metadata[field]);
  const markdown = await unpackNote(published);
  assert.equal(markdown, await unpackNote({ ...metadata, gzip }));
  assert.match(markdown, /^# .+/);
  assert.match(markdown, /^## .+/m);
  assert.match(markdown, /^\s*(?:- |1\. )/m);
  const queue = new NotesQueue(join(state, 'queue.sqlite'));
  let row;
  try {
    row = queue.db
      .prepare('SELECT status,attempts,notes_hash FROM jobs WHERE id=?')
      .get(id);
    assert.equal(row.status, 'completed');
    assert.equal(row.notes_hash, metadata.notesHash);
  } finally {
    queue.close();
  }
  await assert.rejects(stat(join(state, 'jobs', id)), { code: 'ENOENT' });
  const result = {
    verifiedAt: new Date().toISOString(),
    id,
    generatedAt: new Date(metadata.createdAtMs).toISOString(),
    generatedWithHighThinking: true,
    databaseReadback: true,
    readableMarkdown: true,
    checkpoint: 'completed',
    attempts: row.attempts,
    rawBytes: metadata.rawBytes,
    gzipBytes: gzip.length,
    temporaryTranscriptAndWorkspaceDeleted: true,
  };
  await writeFile(
    join(state, 'note-verification.json'),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
