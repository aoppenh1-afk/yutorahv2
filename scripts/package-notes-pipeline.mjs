import { build } from 'esbuild';
import { mkdir, cp, chmod, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve(process.argv[2] ?? 'outputs/notes-pipeline');
// Keep reusable build output separate from private transfer packages.
if (
  await access(directory + '/writer.json').then(
    () => true,
    () => false,
  )
)
  throw new Error('Use an output directory without private credentials.');
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
for (const skill of ['lectern-transcription', 'lectern-notes']) {
  const target = directory + `/packages/transcription/skills/${skill}`;
  await mkdir(target, { recursive: true });
  await cp(
    `packages/transcription/skills/${skill}/SKILL.md`,
    target + '/SKILL.md',
  );
}
for (const name of ['install.sh', 'run.sh']) {
  await cp('deploy/notes-only/' + name, directory + '/' + name);
  await chmod(directory + '/' + name, 0o700);
}
await cp('docs/notes-only-pipeline.md', directory + '/OPERATIONS.md');
await cp('deploy/notes-only/VM-HANDOFF.md', directory + '/VM-HANDOFF.md');
await writeFile(
  directory + '/README.txt',
  `This package has the notes-only pipeline and its complete generation contracts.
Requires Node.js 22.13+, git, and OpenCode 1.18.33. Use the VM's existing opencode-notes binary.
The only allowed model is opencode/muse-spark-1.3-contributor-free. A missing/unavailable free model stops or backs off; it never switches to a paid model.
Install: bash install.sh
Run commands from the installed persistent state directory: ./run.sh help
Pass --opencode /path/to/opencode-notes if the binary is not on PATH.
Provide writer.json privately. It must never be committed or uploaded to a public repository.
The website needs separate read-only credentials, never this writer credential.
All work is outbound. Startup hooks must be configured in your VM service after the pilot.
`,
);
console.log('Packaged ' + directory);
