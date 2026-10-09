import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const state = resolve(process.argv[2]);
const interrupt = process.argv.includes('--interrupt');
const database = new DatabaseSync(join(state, 'queue.sqlite'));
try {
  assert.ok(
    !(await readFile(join(state, 'paused')).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )),
    'Remove paused before testing automatic restart.',
  );
  const boundaryDeadline = Date.now() + 180000;
  while (
    !interrupt &&
    database
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='running'")
      .get().count
  ) {
    assert.ok(
      Date.now() < boundaryDeadline,
      'No job boundary reached; supervisor was left running.',
    );
    await delay(100);
  }
  const completed = database
    .prepare("SELECT id,attempts,notes_hash FROM jobs WHERE status='completed'")
    .all();
  const interruptedJobs = database
    .prepare("SELECT id FROM jobs WHERE status='running'")
    .all();
  const previousPid = Number(
    await readFile(join(state, 'supervisor.pid'), 'utf8'),
  );
  assert.ok(Number.isSafeInteger(previousPid) && previousPid > 1);
  const expected = join(state, 'supervise.sh');
  const args = (await readFile(`/proc/${previousPid}/cmdline`, 'utf8')).split(
    '\0',
  );
  assert.ok(
    args.includes(expected),
    'PID must belong to the notes supervisor.',
  );
  process.kill(previousPid, 'SIGTERM');
  console.log(
    JSON.stringify({
      status: interrupt
        ? 'supervisor_stop_requested'
        : 'supervisor_stopped_at_job_boundary',
      previousPid,
      activeJobs: interruptedJobs.length,
    }),
  );
  const restartDeadline = Date.now() + 90000;
  let currentPid;
  let restarted = false;
  while (Date.now() < restartDeadline) {
    currentPid = Number(
      await readFile(join(state, 'supervisor.pid'), 'utf8').catch(() => '0'),
    );
    if (currentPid > 1 && currentPid !== previousPid) {
      const currentArgs = (
        await readFile(`/proc/${currentPid}/cmdline`, 'utf8').catch(() => '')
      ).split('\0');
      if (currentArgs.includes(expected)) {
        restarted = true;
        break;
      }
    }
    await delay(500);
  }
  assert.ok(restarted, 'Cron did not restart the supervisor.');
  for (const job of completed) {
    const current = database
      .prepare('SELECT status,attempts,notes_hash FROM jobs WHERE id=?')
      .get(job.id);
    assert.equal(current.status, 'completed');
    assert.equal(current.attempts, job.attempts);
    assert.equal(current.notes_hash, job.notes_hash);
  }
  const oldSupervisor = await readFile(
    `/proc/${previousPid}/cmdline`,
    'utf8',
  ).catch(() => '');
  assert.ok(
    !oldSupervisor.split('\0').includes(expected),
    'Old supervisor must have exited.',
  );
  const resumeDeadline = Date.now() + 120000;
  let activeAfterRestart = 0;
  let completedAfterRestart = 0;
  while (Date.now() < resumeDeadline) {
    activeAfterRestart = database
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='running'")
      .get().count;
    completedAfterRestart = database
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='completed'")
      .get().count;
    if (activeAfterRestart || completedAfterRestart > completed.length) break;
    await delay(500);
  }
  assert.ok(
    activeAfterRestart || completedAfterRestart > completed.length,
    'Worker did not resume jobs.',
  );
  const result = {
    verifiedAt: new Date().toISOString(),
    previousPid,
    currentPid,
    restartedByCron: true,
    completedJobsUnchanged: completed.length,
    interruptedJobs: interruptedJobs.map((job) => job.id),
    workerResumed: true,
    activeAfterRestart,
  };
  await writeFile(
    join(state, 'cron-verification.json'),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
} finally {
  database.close();
}
