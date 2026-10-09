import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFile = promisify(execFileCallback);
void test('a newly built high-thinking package accepts VM preparation and runs its durable queue', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  await mkdir(app);
  const bundle = join(app, 'notes-pipeline.mjs');
  await build({
    entryPoints: ['apps/notes-only/src/cli.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  for (const name of ['pool.mjs', 'catalog-fetch.mjs'])
    await cp('deploy/notes-only/' + name, join(root, name));
  await execFile(process.execPath, [
    'deploy/notes-only/prepare-runtime.mjs',
    bundle,
  ]);
  const prepared = await readFile(bundle, 'utf8');
  await execFile(process.execPath, [
    'deploy/notes-only/prepare-runtime.mjs',
    bundle,
  ]);
  assert.equal(await readFile(bundle, 'utf8'), prepared);
  assert.match(prepared, /await select\("effort", "high"\)/);
  assert.match(prepared, /VM concurrent notes support v2/);
  const help = await execFile(process.execPath, [bundle, 'help']);
  assert.match(help.stdout, /--concurrency 1\.\.6/);
  const state = join(root, 'state');
  await execFile(process.execPath, [
    bundle,
    'enqueue',
    '--ids',
    '1190357',
    '--state',
    state,
  ]);
  const status = await execFile(process.execPath, [
    bundle,
    'status',
    '--state',
    state,
  ]);
  assert.deepEqual(JSON.parse(status.stdout).jobs, [
    { status: 'queued', count: 1 },
  ]);
});
