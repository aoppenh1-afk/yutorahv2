import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const commit = '28d440b5dd449dbf1fe6f3506cf94ecca4d02660';
const sha256 = '746542c72b9108f70c19147b6afa2ae382469450d2590118d3dd5b97887cc53c';
const vendor = fileURLToPath(new URL('../vendor/', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'yutorah-braces-package-'));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}

try {
  const response = await fetch(`https://codeload.github.com/micromatch/braces/tar.gz/${commit}`);
  assert.ok(response.ok, `Upstream download returned ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(archive).digest('hex'), sha256, 'Upstream source changed');
  const archivePath = join(directory, 'source.tgz');
  const source = join(directory, 'source');
  mkdirSync(source);
  writeFileSync(archivePath, archive);
  run('tar', ['-xzf', archivePath, '-C', source, '--strip-components=1']);

  const manifestPath = join(source, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = '@yutorah/braces';
  manifest.version = '3.0.4-yutorah.0';
  manifest.private = true;
  manifest.yutorahPatch = {
    upstream: 'micromatch/braces',
    commit,
    pullRequest: 72,
    advisory: 'GHSA-vfj7-8cjw-p6xm',
  };
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.verb;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  mkdirSync(vendor, { recursive: true });
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', vendor, source]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
