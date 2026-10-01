import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperatorRuntime } from '../src/operator-runtime.js';
import { type runWorker } from '../src/worker.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import { SessionPool } from '../../../packages/antigravity-acp/src/pool.js';
import { type TranscriptionStore } from '../../../packages/transcription/src/store.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';

const waitMs = (5 * 60 + 1) * 60_000;
const detectedAt = Date.parse('2026-10-01T16:00:00Z');

async function fixture(t: TestContext, exhaustionCount = 1, drainDelayMs = 0) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: detectedAt });
  const root = await mkdtemp(join(tmpdir(), 'operator-quota-clock-'));
  const skill = join(root, 'skill.md');
  await writeFile(skill, 'Complete transcription contract');
  await writeFile(join(root, 'agy_acp_server.par'), '', { mode: 0o700 });
  const settings = {
    model: defaultSettings.model,
    notes_enabled: false,
    worker_enabled: false,
    quota_resume_at: null as Date | null,
  };
  const store = {
    pool: {
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes('FROM transcription_targets'))
          return { rows: [{ enabled: true }] };
        if (sql.startsWith('SELECT model,')) return { rows: [{ ...settings }] };
        if (
          sql.startsWith('UPDATE transcription_operator_settings SET model=')
        ) {
          settings.model = args[0] as string;
          settings.notes_enabled = args[1] as boolean;
          settings.worker_enabled = args[2] as boolean;
          if (!settings.worker_enabled) settings.quota_resume_at = null;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('SET quota_resume_at=')) {
          if (settings.worker_enabled)
            settings.quota_resume_at = args[0] as Date | null;
          return {
            rowCount: 1,
            rows: [{ quota_resume_at: settings.quota_resume_at }],
          };
        }
        assert.fail('Unexpected SQL in scheduler test: ' + sql);
      },
    },
  } as unknown as TranscriptionStore;
  let calls = 0;
  const worker: typeof runWorker = async (_store, config, signal) => {
    calls++;
    if (calls <= exhaustionCount) {
      config.onQuotaExhausted?.();
      if (drainDelayMs)
        await new Promise<void>((resolve) => setTimeout(resolve, drainDelayMs));
      throw new Failure('quota_exhausted');
    }
    config.onReady?.([settings.model], new SessionPool(5));
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
  const runtimes: OperatorRuntime[] = [];
  const create = () => {
    const runtime = new OperatorRuntime(
      store,
      {
        runtime: {
          directory: root,
          profile: join(root, 'profile'),
          scratch: join(root, 'scratch'),
        },
        transcriptionSkillPath: skill,
        notesSkillPath: skill,
        concurrency: 5,
        intervalMs: 300_000,
      },
      worker,
    );
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await rm(root, { recursive: true, force: true });
    t.mock.timers.reset();
  });
  return { create, settings, calls: () => calls };
}

async function state(runtime: OperatorRuntime, expected: string) {
  for (let i = 0; i < 30; i++) {
    const status = await runtime.status();
    if (status.state === expected) return status;
    await nextTurn();
  }
  assert.equal((await runtime.status()).state, expected);
  throw new Error('unreachable');
}

void test('quota exhaustion resumes exactly five hours and one minute after detection', async (t) => {
  const f = await fixture(t);
  const runtime = f.create();
  await runtime.start();
  const paused = await state(runtime, 'waiting_quota');
  assert.equal(paused.resumeAt, new Date(detectedAt + waitMs).toISOString());
  assert.equal(f.settings.quota_resume_at?.getTime(), detectedAt + waitMs);
  assert.equal(f.calls(), 1);
  t.mock.timers.tick(waitMs - 1);
  await nextTurn();
  assert.equal(f.calls(), 1, 'no model work before the saved deadline');
  t.mock.timers.tick(1);
  await state(runtime, 'running');
  assert.equal(f.calls(), 2);
  assert.equal(f.settings.quota_resume_at, null);
});

void test('service restart preserves the original quota resume deadline', async (t) => {
  const f = await fixture(t);
  const original = f.create();
  await original.start();
  await state(original, 'waiting_quota');
  await original.close();
  assert.equal(f.settings.worker_enabled, true);
  assert.equal(f.settings.quota_resume_at?.getTime(), detectedAt + waitMs);
  t.mock.timers.tick(60 * 60_000);
  const restarted = f.create();
  await restarted.restore();
  assert.equal(
    (await restarted.status()).resumeAt,
    new Date(detectedAt + waitMs).toISOString(),
  );
  t.mock.timers.tick(waitMs - 60 * 60_000 - 1);
  await nextTurn();
  assert.equal(f.calls(), 1);
  t.mock.timers.tick(1);
  await state(restarted, 'running');
  assert.equal(f.calls(), 2);
});

void test('manual pause cancels automatic quota resume, including across restart', async (t) => {
  const f = await fixture(t);
  const runtime = f.create();
  await runtime.start();
  await state(runtime, 'waiting_quota');
  await runtime.stop();
  assert.equal((await runtime.status()).error, null);
  assert.equal((await runtime.status()).resumeAt, null);
  assert.equal(f.settings.worker_enabled, false);
  assert.equal(f.settings.quota_resume_at, null);
  const restarted = f.create();
  await restarted.restore();
  t.mock.timers.tick(waitMs + 1);
  await nextTurn();
  assert.equal(f.calls(), 1);
  assert.equal((await restarted.status()).state, 'stopped');
});

void test('another exhausted allowance schedules a fresh five-hour-one-minute wait', async (t) => {
  const f = await fixture(t, 2);
  const runtime = f.create();
  await runtime.start();
  await state(runtime, 'waiting_quota');
  t.mock.timers.tick(waitMs);
  for (let i = 0; i < 30 && f.calls() < 2; i++) await runtime.status();
  await state(runtime, 'waiting_quota');
  assert.equal(f.calls(), 2);
  assert.equal(f.settings.quota_resume_at?.getTime(), detectedAt + 2 * waitMs);
  t.mock.timers.tick(waitMs);
  await state(runtime, 'running');
  assert.equal(f.calls(), 3);
});

void test('the resume deadline starts at provider detection before worker cleanup', async (t) => {
  const f = await fixture(t, 1, 1000);
  const runtime = f.create();
  await runtime.start();
  t.mock.timers.tick(1000);
  const paused = await state(runtime, 'waiting_quota');
  assert.equal(paused.resumeAt, new Date(detectedAt + waitMs).toISOString());
  t.mock.timers.tick(waitMs - 1000);
  await state(runtime, 'running');
  assert.equal(f.calls(), 2);
});

void test('manual continuation resumes now and cancels the old quota timer', async (t) => {
  const f = await fixture(t);
  const runtime = f.create();
  await runtime.start();
  await state(runtime, 'waiting_quota');
  await runtime.start();
  await state(runtime, 'running');
  assert.equal(f.calls(), 2);
  assert.equal(f.settings.quota_resume_at, null);
  t.mock.timers.tick(waitMs);
  await nextTurn();
  assert.equal(f.calls(), 2);
});
