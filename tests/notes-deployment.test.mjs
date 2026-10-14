import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  cp,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
const execFile = promisify(callback);
void test('emitted bundle installs idempotently, preserves WAL checkpoints and credentials, enforces locks, and rolls back the runtime without losing newer work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, 'package'),
    state = join(root, 'state');
  await mkdir(state);
  await mkdir(pkg);
  await execFile(process.execPath, ['scripts/package-notes-pipeline.mjs', pkg]);
  await writeFile(join(state, 'writer.json'), 'private fixture', {
    mode: 0o600,
  });
  await writeFile(join(state, 'paused'), '');
  const db = new DatabaseSync(join(state, 'queue.sqlite'));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE jobs(id TEXT PRIMARY KEY,title TEXT NOT NULL,teacher TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,notes_hash TEXT);INSERT INTO jobs(id,title,teacher,status,attempts,notes_hash) VALUES('1','Preserved','Teacher','completed',4,'original-hash')",
  );
  const env = {
    ...process.env,
    NOTES_NODE: process.execPath,
    YUTORAH_NOTES_STATE: state,
  };
  await execFile('bash', [join(pkg, 'install.sh')], { env });
  assert.equal(
    await readFile(join(state, 'writer.json'), 'utf8'),
    'private fixture',
  );
  assert.equal((await stat(join(state, 'writer.json'))).mode & 0o777, 0o600);
  const result = await execFile(join(state, 'run.sh'), [
    'enqueue',
    '--ids',
    '2',
  ]);
  assert.match(result.stdout, /discovered/);
  const held = new DatabaseSync(join(state, 'queue.sqlite'));
  const row = held.prepare("SELECT * FROM jobs WHERE id='1'").get();
  assert.equal(row.attempts, 4);
  assert.equal(row.notes_hash, 'original-hash');
  assert.equal(row.status, 'completed');
  held.close();
  db.close();
  await execFile('bash', [join(pkg, 'install.sh')], { env });
  const after = JSON.parse(
    (await execFile(join(state, 'run.sh'), ['status'])).stdout,
  );
  assert.deepEqual(after.jobs, [
    { status: 'completed', count: 1 },
    { status: 'discovered', count: 1 },
  ]);
  await execFile('flock', ['-n', join(state, 'process.lock'), 'sleep', '.5']);
  const locking = await execFile('bash', [
    '-c',
    'flock -n "$1" sleep 1 & wait',
    'lock',
    join(state, 'process.lock'),
  ]);
  assert.equal(locking.stderr, '');
  await execFile(join(state, 'rollback.sh'));
  assert.equal(await readFile(join(state, 'route'), 'utf8'), 'acp-high\n');
  const rolled = JSON.parse(
    (await execFile(join(state, 'run.sh'), ['status'])).stdout,
  );
  assert.deepEqual(rolled.jobs, after.jobs);
  const manifest = JSON.parse(
    await readFile(join(state, 'installation.json'), 'utf8'),
  );
  assert.equal(manifest.integrity, 'ok');
  assert.equal(manifest.completedPreserved, 1);
  assert.equal(manifest.schema, 2);
  assert.equal(
    await readFile(
      join(
        state,
        'app/packages/notes-only/skills/written-shiur-notes/SKILL.md',
      ),
      'utf8',
    ),
    await readFile(
      'packages/notes-only/skills/written-shiur-notes/SKILL.md',
      'utf8',
    ),
  );
});
void test('the supervisor honors persistent 3/4/1 pools and selects automatic server rollout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-supervise-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp('deploy/notes-only/supervise.sh', join(root, 'supervise.sh'));
  await cp(
    'deploy/notes-only/pool-settings.mjs',
    join(root, 'pool-settings.mjs'),
  );
  await mkdir(join(root, 'bin'));
  await cp(process.execPath, join(root, 'bin/node'));
  await writeFile(
    join(root, 'pools.json'),
    JSON.stringify({ fetchers: 3, generators: 4, publishers: 1 }),
  );
  await writeFile(join(root, 'route'), 'server-high\n');
  await writeFile(
    join(root, 'run.sh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$(dirname "$0")/args"
touch "$(dirname "$0")/paused"
kill -TERM "$PPID"
`,
    { mode: 0o700 },
  );
  await execFile('bash', [join(root, 'supervise.sh')], { timeout: 5000 });
  const args = (await readFile(join(root, 'args'), 'utf8')).trim().split('\n');
  assert.equal(args[0], 'rollout');
  assert.ok(args.includes('--inventory'));
  assert.equal(args[args.indexOf('--route') + 1], 'server-high');
  assert.equal(args[args.indexOf('--concurrency') + 1], '4');
  assert.equal(args[args.indexOf('--fetchers') + 1], '3');
  assert.equal(args[args.indexOf('--publishers') + 1], '1');
  assert.equal(args[args.indexOf('--min-free-memory-mib') + 1], '3072');
});

void test('invalid persistent pool settings fail before any worker starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-pools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const settings of [
    { fetchers: 3, generators: 11, publishers: 1 },
    { fetchers: 3, generators: '4', publishers: 1 },
  ]) {
    const path = join(root, 'pools.json');
    await writeFile(path, JSON.stringify(settings));
    await assert.rejects(
      execFile(process.execPath, ['deploy/notes-only/pool-settings.mjs', path]),
      /Invalid pool setting/,
    );
  }
});
