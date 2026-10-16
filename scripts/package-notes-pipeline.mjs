import { build } from 'esbuild';
import {
  mkdir,
  cp,
  chmod,
  writeFile,
  access,
  readFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const directory = resolve(process.argv[2] ?? 'outputs/notes-pipeline');
if (
  await access(directory + '/writer.json').then(
    () => true,
    () => false,
  )
)
  throw new Error('Build into a directory without private credentials.');
await mkdir(directory, { recursive: true, mode: 0o700 });
await build({
  entryPoints: ['apps/notes-only/src/cli.ts'],
  outfile: directory + '/notes-pipeline.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const target = directory + '/packages/notes-only/skills/written-shiur-notes';
await mkdir(target, { recursive: true });
await cp('packages/notes-only/skills/written-shiur-notes', target, {
  recursive: true,
});
// Preserve the complete transcription contract as a versioned reference, independently of notes generation.
const reference =
  directory + '/packages/transcription/skills/lectern-transcription';
await mkdir(reference, { recursive: true });
await cp('packages/transcription/skills/lectern-transcription', reference, {
  recursive: true,
});
for (const name of [
  'install.sh',
  'run.sh',
  'supervise.sh',
  'ensure-running.sh',
  'status.sh',
  'backup.sh',
  'pause.sh',
  'resume.sh',
  'rollback.sh',
  'installation.mjs',
  'pool-settings.mjs',
]) {
  await cp('deploy/notes-only/' + name, directory + '/' + name);
  await chmod(directory + '/' + name, name.endsWith('.sh') ? 0o700 : 0o600);
}
await cp('docs/notes-only-pipeline.md', directory + '/OPERATIONS.md');
await cp(
  'deploy/notes-only/priority-teachers.json',
  directory + '/priority-teachers.json',
);
await cp(
  'packages/transcription/LECTERN-LICENSE',
  directory + '/packages/transcription/LECTERN-LICENSE',
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  format: 2,
  createdAt: Date.now(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  sourceDiffSha256: hash(execFileSync('git', ['diff', '--binary', 'HEAD'])),
  bundleSha256: hash(await readFile(directory + '/notes-pipeline.mjs')),
  contractSha256: hash(await readFile(target + '/SKILL.md')),
  runtime: 'opencode:1.18.33',
  model: 'opencode/muse-spark-1.3-contributor-free',
  effort: 'high',
  defaultRoute: 'acp-high',
  defaultPools: { fetchers: 3, generators: 4, publishers: 1 },
  maxAiConcurrency: 6,
  normalizer: 'presentation-4',
  languagePolicy: 'english-prose-1',
  schema: 2,
};
await writeFile(
  directory + '/manifest.json',
  JSON.stringify(manifest, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify({ directory, ...manifest }));
