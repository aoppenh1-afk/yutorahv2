import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFile = promisify(execFileCallback);
void test('the supervisor admits work below 3 GiB and keeps refilling through ordinary long jobs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-supervisor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp('deploy/notes-only/supervise.sh', join(root, 'supervise.sh'));
  await writeFile(join(root, 'catalog.last'), '');
  await writeFile(
    join(root, 'run.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
notes_state=$(dirname -- "$0")
printf '%s\\n' "$@" >"$notes_state/args"
touch "$notes_state/paused"
kill -TERM "$PPID"
`,
    { mode: 0o700 },
  );
  await execFile('bash', [join(root, 'supervise.sh')], { timeout: 5000 });
  const args = (await readFile(join(root, 'args'), 'utf8')).trim().split('\n');
  assert.equal(args[0], 'run');
  assert.ok(Number(args[args.indexOf('--min-free-memory-mib') + 1]) <= 1024);
  assert.ok(Number(args[args.indexOf('--max-runtime-ms') + 1]) >= 6 * 3600000);
  assert.equal(args[args.indexOf('--concurrency') + 1], '10');
});
