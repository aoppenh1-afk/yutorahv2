import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

const execFile = promisify(execFileCallback);
const backup = resolve('deploy/notes-only/backup.mjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'notes-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state');
  const destination = join(directory, 'backup');
  const note = join(state, 'notes', '1190833');
  await mkdir(note, { recursive: true });
  await writeFile(
    join(state, 'writer.json'),
    'credential must never enter backups',
  );
  const raw = Buffer.from('- תורה and a grounded outline\n');
  const metadata = {
    shiurId: '1190833',
    rawBytes: raw.length,
    notesHash: createHash('sha256').update(raw).digest('hex'),
  };
  await writeFile(join(note, 'notes.md.gz'), gzipSync(raw));
  await writeFile(join(note, 'metadata.json'), JSON.stringify(metadata));
  return { state, destination, note, metadata, raw };
}

void test('backups preserve compressed Unicode notes, verify hashes, and omit credentials', async (t) => {
  const { state, destination, note } = await fixture(t);
  await execFile(process.execPath, [backup, state, destination]);
  assert.deepEqual(
    await readFile(join(destination, '1190833', 'notes.md.gz')),
    await readFile(join(note, 'notes.md.gz')),
  );
  await assert.rejects(readFile(join(destination, 'writer.json')), {
    code: 'ENOENT',
  });
  const status = JSON.parse(
    await readFile(join(destination, 'status.json'), 'utf8'),
  );
  assert.equal(status.copied, 1);
  assert.equal(status.pending, 0);
  await execFile(process.execPath, [backup, state, destination]);
  const second = JSON.parse(
    await readFile(join(destination, 'status.json'), 'utf8'),
  );
  assert.equal(second.copied, 0);
  assert.equal(second.unchanged, 1);
});

void test('corrupt source notes cannot replace a verified backup', async (t) => {
  const { state, destination, note } = await fixture(t);
  await execFile(process.execPath, [backup, state, destination]);
  const original = await readFile(join(destination, '1190833', 'notes.md.gz'));
  await writeFile(join(note, 'notes.md.gz'), gzipSync('corrupt replacement'));
  await assert.rejects(
    execFile(process.execPath, [backup, state, destination]),
  );
  assert.deepEqual(
    await readFile(join(destination, '1190833', 'notes.md.gz')),
    original,
  );
});

void test('an unfinished note is skipped until its durable metadata exists', async (t) => {
  const { state, destination } = await fixture(t);
  await mkdir(join(state, 'notes', '1190000'));
  await execFile(process.execPath, [backup, state, destination]);
  const status = JSON.parse(
    await readFile(join(destination, 'status.json'), 'utf8'),
  );
  assert.equal(status.pending, 1);
  await assert.rejects(
    readFile(join(destination, '1190000', 'metadata.json')),
    { code: 'ENOENT' },
  );
});
