import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [stateArg, destinationArg] = process.argv.slice(2);
if (!stateArg || !destinationArg)
  throw new Error('Provide state and backup directories.');
const state = resolve(stateArg);
const destination = resolve(destinationArg);
await mkdir(destination, { recursive: true, mode: 0o700 });

async function durableCopy(filename, bytes) {
  const temporary = filename + '.next';
  const file = await open(temporary, 'w', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, filename);
}

let copied = 0;
let pending = 0;
let unchanged = 0;
for (const id of await readdir(join(state, 'notes'))) {
  if (!/^[1-9]\d{0,11}$/.test(id)) continue;
  const source = join(state, 'notes', id);
  let metadataBytes;
  try {
    metadataBytes = await readFile(join(source, 'metadata.json'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      pending++;
      continue;
    }
    throw error;
  }
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const compressed = await readFile(join(source, 'notes.md.gz'));
  const raw = gunzipSync(compressed, { maxOutputLength: 1024 * 1024 });
  if (
    metadata.shiurId !== id ||
    raw.length !== metadata.rawBytes ||
    createHash('sha256').update(raw).digest('hex') !== metadata.notesHash
  )
    throw new Error('Note backup failed checksum verification.');
  const target = join(destination, id);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const previous = await readFile(join(target, 'metadata.json')).catch(
    (error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (
    previous &&
    JSON.parse(previous.toString('utf8')).notesHash !== metadata.notesHash
  )
    throw new Error('Existing backup conflicts with current notes.');
  const previousGzip = previous
    ? await readFile(join(target, 'notes.md.gz')).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      })
    : null;
  if (previous?.equals(metadataBytes) && previousGzip?.equals(compressed)) {
    unchanged++;
    continue;
  }
  await durableCopy(join(target, 'notes.md.gz'), compressed);
  await durableCopy(join(target, 'metadata.json'), metadataBytes);
  const directory = await open(target, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  copied++;
}
await durableCopy(
  join(destination, 'status.json'),
  Buffer.from(
    JSON.stringify({
      completedAt: new Date().toISOString(),
      copied,
      pending,
      unchanged,
      verified: copied + unchanged,
    }),
  ),
);
const directory = await open(destination, 'r');
try {
  await directory.sync();
} finally {
  await directory.close();
}
await rm(join(destination, 'status.json.next'), { force: true });
console.log(
  JSON.stringify({
    status: 'backup_verified',
    copied,
    unchanged,
    verified: copied + unchanged,
    pending,
  }),
);
