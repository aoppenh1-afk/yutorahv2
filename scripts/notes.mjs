import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
const args = process.argv.slice(2),
  i = args.indexOf('--state');
const state = resolve(
  i < 0 ? join(homedir(), '.local/share/yutorah-notes') : args[i + 1],
);
await mkdir(state, { recursive: true, mode: 0o700 });
const child = spawn(
  'flock',
  [
    '-n',
    '-E',
    '75',
    join(state, 'process.lock'),
    process.execPath,
    '--import',
    'tsx',
    'apps/notes-only/src/cli.ts',
    ...args,
  ],
  { stdio: 'inherit', env: { ...process.env, YUTORAH_NOTES_LOCK_HELD: '1' } },
);
for (const name of ['SIGTERM', 'SIGINT'])
  process.once(name, () => child.kill(name));
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
