import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [command, state, rollback] = process.argv.slice(2);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function sync(path) {
  const fd = await open(path, 'r');
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function syncTree(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) await syncTree(target);
    else if (entry.isFile()) await sync(target);
  }
  await sync(path);
}
if (command === 'snapshot') {
  let completed = [];
  try {
    const db = new DatabaseSync(join(state, 'queue.sqlite'), {
      readOnly: true,
    });
    db.prepare('VACUUM INTO ?').run(join(rollback, 'queue.sqlite'));
    await sync(join(rollback, 'queue.sqlite'));
    completed = db
      .prepare(
        "SELECT id,attempts,notes_hash FROM jobs WHERE status='completed' ORDER BY id",
      )
      .all();
    db.close();
  } catch (e) {
    if (!/unable to open database/.test(e.message)) throw e;
  }
  const credential = await readFile(join(state, 'writer.json')).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  await writeFile(
    join(rollback, 'preservation.json'),
    JSON.stringify({
      completed,
      credentialHash: credential ? hash(credential) : null,
    }),
    { mode: 0o600 },
  );
  await sync(join(rollback, 'preservation.json'));
  await sync(rollback);
} else if (command === 'verify') {
  const before = JSON.parse(
    await readFile(join(rollback, 'preservation.json'), 'utf8'),
  );
  const db = new DatabaseSync(join(state, 'queue.sqlite'), { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw Error('SQLite integrity failed.');
  for (const row of before.completed) {
    const after = db
      .prepare('SELECT attempts,notes_hash,status FROM jobs WHERE id=?')
      .get(row.id);
    if (
      !after ||
      after.status !== 'completed' ||
      after.attempts !== row.attempts ||
      after.notes_hash !== row.notes_hash
    )
      throw Error('Completed checkpoint changed.');
  }
  if (
    before.credentialHash &&
    hash(await readFile(join(state, 'writer.json'))) !== before.credentialHash
  )
    throw Error('Writer credential changed.');
  const manifest = JSON.parse(
    await readFile(join(state, 'app/manifest.json'), 'utf8'),
  );
  const bundleHash = hash(
    await readFile(join(state, 'app/notes-pipeline.mjs')),
  );
  if (bundleHash !== manifest.bundleSha256)
    throw Error('Installed bundle differs from package.');
  await writeFile(
    join(state, 'installation.json'),
    JSON.stringify({
      ...manifest,
      installedAt: Date.now(),
      schema: 2,
      completedPreserved: before.completed.length,
      integrity,
      rollback,
      credentialPreserved: true,
    }),
    { mode: 0o600 },
  );
  await syncTree(join(state, 'app'));
  await sync(join(state, 'releases'));
  await sync(join(state, 'installation.json'));
  await sync(state);
  db.close();
  console.log(
    JSON.stringify({
      integrity,
      completedPreserved: before.completed.length,
      bundleHash,
    }),
  );
} else throw Error('Unknown installation command.');
