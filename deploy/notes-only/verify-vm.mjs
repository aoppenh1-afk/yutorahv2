import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const state = resolve(process.argv[2]);
const temporary = await mkdtemp(join(state, '.verification-'));
try {
  const bundled = await readFile(join(state, 'app/notes-pipeline.mjs'), 'utf8');
  const modulePath = join(temporary, 'modules.mjs');
  await writeFile(
    modulePath,
    bundled.slice(0, bundled.lastIndexOf('// apps/notes-only/src/cli.ts')) +
      '\nexport { NotesQueue, TiDBNotesStore, unpackNote };\n',
    { mode: 0o600 },
  );
  const { NotesQueue, TiDBNotesStore, unpackNote } = await import(
    pathToFileURL(modulePath).href
  );
  const store = new TiDBNotesStore(
    JSON.parse(await readFile(join(state, 'writer.json'), 'utf8')),
  );
  const pilots = [];
  for (const id of ['1190357', '1190833']) {
    const metadata = JSON.parse(
      await readFile(join(state, 'notes', id, 'metadata.json'), 'utf8'),
    );
    const gzip = new Uint8Array(
      await readFile(join(state, 'notes', id, 'notes.md.gz')),
    );
    const published = await store.get(id);
    assert.ok(published, 'Pilot must exist in the database.');
    assert.equal(
      await unpackNote(published),
      await unpackNote({ ...metadata, gzip }),
    );
    assert.equal(published.notesHash, metadata.notesHash);
    const queue = new NotesQueue(join(state, 'queue.sqlite'));
    try {
      const row = queue.db
        .prepare('SELECT status, notes_hash FROM jobs WHERE id=?')
        .get(id);
      assert.equal(row.status, 'completed');
      assert.equal(row.notes_hash, metadata.notesHash);
    } finally {
      queue.close();
    }
    await assert.rejects(readFile(join(state, 'jobs', id, 'source.vtt')), {
      code: 'ENOENT',
    });
    pilots.push({
      id,
      databaseReadback: true,
      checkpoint: 'completed',
      rawBytes: metadata.rawBytes,
      gzipBytes: gzip.length,
      temporarySourceDeleted: true,
    });
  }
  const recoveryRoot = join(temporary, 'recovery');
  await mkdir(recoveryRoot);
  const recovered = new NotesQueue(join(recoveryRoot, 'queue.sqlite'));
  recovered.enqueue([{ id: '1190833' }]);
  recovered.claim();
  recovered.close();
  // Simulate a crash after lock creation, before writing owner metadata.
  await mkdir(join(recoveryRoot, 'runner.lock'));
  const runner = join(state, 'run.sh');
  const credential = join(state, 'writer.json');
  const recovery = await execFile(
    runner,
    [
      'run',
      '--limit',
      '1',
      '--state',
      recoveryRoot,
      '--credential',
      credential,
      '--opencode',
      '/bin/false',
    ],
    { timeout: 60000 },
  );
  assert.match(recovery.stdout, /already_published/);
  const queue = new NotesQueue(join(recoveryRoot, 'queue.sqlite'));
  try {
    assert.deepEqual(
      queue.status().map((item) => ({ ...item })),
      [{ status: 'completed', count: 1 }],
    );
  } finally {
    queue.close();
  }
  const idleRoot = join(temporary, 'idle');
  const before = Date.now();
  await execFile(
    runner,
    [
      'run',
      '--all',
      '--follow',
      '--max-runtime-ms',
      '1000',
      '--state',
      idleRoot,
      '--credential',
      credential,
      '--opencode',
      '/bin/false',
    ],
    { timeout: 10000 },
  );
  assert.ok(
    Date.now() - before < 10000,
    'Idle worker must yield for catalog discovery.',
  );
  const result = {
    verifiedAt: new Date().toISOString(),
    pilots,
    crashRecoveryWithoutGeneration: true,
    ownerlessLockRecovery: true,
    boundedIdleWorker: true,
  };
  await writeFile(
    join(state, 'verification.json'),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
