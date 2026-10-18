import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as callback, spawn } from 'node:child_process';
import { once } from 'node:events';
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
import { createHash } from 'node:crypto';
const execFile = promisify(callback);
void test('a following rollout waits through memory admission without empty supervisor restart cycles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-rollout-follow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, 'package'),
    state = join(root, 'state');
  await mkdir(state);
  await mkdir(pkg);
  await execFile(process.execPath, ['scripts/package-notes-pipeline.mjs', pkg]);
  const manifest = JSON.parse(
    await readFile(join(pkg, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.model, 'opencode/deepseek-v4.1-flash-free');
  assert.equal(manifest.effort, 'high');
  const help = await execFile(process.execPath, [
    join(pkg, 'notes-pipeline.mjs'),
    'help',
  ]);
  assert.match(
    help.stdout,
    /opencode\/deepseek-v4\.1-flash-free, plan, high only/,
  );
  const env = {
    ...process.env,
    NOTES_NODE: process.execPath,
    YUTORAH_NOTES_STATE: state,
  };
  await execFile('bash', [join(pkg, 'install.sh')], { env });
  const notesSkill = await readFile(
    join(pkg, 'packages/notes-only/skills/written-shiur-notes/SKILL.md'),
    'utf8',
  );
  const profile = createHash('sha256')
    .update(
      JSON.stringify({
        model: 'opencode/deepseek-v4.1-flash-free',
        language: 'hebrewEnglish',
        runtime: 'opencode:1.18.33:server:plan:high:v1',
        notesSkill,
        pipeline: 'written-shiur-1',
      }),
    )
    .digest('hex');
  const db = new DatabaseSync(join(state, 'queue.sqlite'));
  db.prepare('INSERT INTO approvals VALUES(?,?,?)').run(
    profile,
    JSON.stringify({ phase: 'quality', concurrency: 4 }),
    Date.now(),
  );
  db.exec(
    "INSERT INTO jobs(id,title,teacher,status,eligibility,source_path,source_hash,source_bytes) VALUES('1','Pending','Teacher','ready','eligible','sources/cached.vtt','unused',100)",
  );
  db.close();
  await writeFile(
    join(state, 'writer.json'),
    JSON.stringify({
      host: 'gateway01.us-east-1.prod.aws.tidbcloud.com',
      username: 'fixture',
      password: 'fixture',
      database: 'notes',
    }),
  );
  const result = await execFile(
    join(state, 'run.sh'),
    [
      'rollout',
      '--route',
      'server-high',
      '--follow',
      '--max-runtime-ms',
      '600',
      '--min-free-memory-mib',
      '100000',
      '--opencode',
      'must-not-launch',
    ],
    { timeout: 10000 },
  );
  const records = result.stdout.trim().split('\n').map(JSON.parse);
  const first = records.find((r) => r.type === 'metrics');
  const final = records.find((r) => r.selected !== undefined);
  assert.equal(final.selected, 0);
  assert.ok(
    final.metrics.observedMs >= 600,
    '--follow was ignored during the quality rollout',
  );
  assert.ok(first);
  assert.equal(final.metrics.activeProviderRequests, 0);
});
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
    { fetchers: 3, generators: 7, publishers: 1 },
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

void test('qualification refuses seven sessions, unpaused production, and an occupied production lock before starting inference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-qualification-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'trial');
  const command = [
    '--import',
    'tsx',
    'scripts/qualify-notes.ts',
    '--production-state',
    root,
    '--output',
    output,
    '--opencode',
    'must-not-launch',
  ];
  await assert.rejects(
    execFile(process.execPath, [...command, '--concurrency', '7']),
    /Invalid concurrency/,
  );
  await assert.rejects(execFile(process.execPath, command), /Pause production/);
  await writeFile(join(root, 'paused'), '');
  const holder = spawn(
    'flock',
    [
      '-n',
      join(root, 'process.lock'),
      process.execPath,
      '-e',
      "process.stdout.write('held');process.stdin.resume()",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => {
    holder.stdin.end();
  });
  await once(holder.stdout, 'data');
  await assert.rejects(
    execFile(process.execPath, command),
    (error) => error.code === 75,
  );
  await assert.rejects(stat(output), { code: 'ENOENT' });
  const exited = once(holder, 'exit');
  holder.stdin.end();
  await exited;
});
