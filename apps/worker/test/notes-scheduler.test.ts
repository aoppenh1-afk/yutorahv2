import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OperatorRuntime } from '../src/operator-runtime.js';
import { type runWorker } from '../src/worker.js';
import { type runNotesWorker } from '../src/notes-worker.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import { SessionPool } from '../../../packages/antigravity-acp/src/pool.js';
import { type TranscriptionStore } from '../../../packages/transcription/src/store.js';
import { FREE_NOTES_MODEL } from '../../../packages/opencode-acp/src/runtime.js';

async function fixture(
  t: TestContext,
  failNotes: boolean | 'storage_exhausted' = false,
  restoring = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'notes-scheduler-'));
  const settings = {
    model: 'gemini-3.8-flash-medium',
    notes_enabled: true,
    worker_enabled: restoring,
    quota_resume_at: restoring
      ? new Date(Date.now() + 60_000)
      : (null as Date | null),
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
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SET quota_resume_at=')) {
          settings.quota_resume_at = args[0] as Date | null;
          return {
            rows: [{ quota_resume_at: settings.quota_resume_at }],
            rowCount: 1,
          };
        }
        throw new Error('Unexpected scheduler SQL');
      },
    },
  } as unknown as TranscriptionStore;
  let audioCalls = 0;
  let notesCalls = 0;
  let notesActive = false;
  const untilAbort = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  const audio: typeof runWorker = async (_store, config, signal) => {
    audioCalls++;
    assert.equal(config.notes?.model, FREE_NOTES_MODEL);
    if (audioCalls === 1 && !failNotes) {
      config.onQuotaExhausted?.();
      throw new Failure('quota_exhausted');
    }
    config.onReady?.([settings.model], new SessionPool(5));
    await untilAbort(signal);
  };
  const notes: typeof runNotesWorker = async (_store, config, signal) => {
    notesCalls++;
    assert.equal(config.concurrency, 2);
    if (failNotes)
      throw new Failure(failNotes === true ? 'auth_required' : failNotes);
    notesActive = true;
    config.onStatus?.({
      state: 'running',
      model: FREE_NOTES_MODEL,
      concurrency: 2,
      activeSessions: 1,
      resumeAt: null,
      error: null,
    });
    await untilAbort(signal);
    notesActive = false;
  };
  const runtime = new OperatorRuntime(
    store,
    {
      runtime: {
        directory: root,
        profile: join(root, 'profile'),
        scratch: join(root, 'scratch'),
      },
      transcriptionSkillPath: resolve(
        'packages/transcription/skills/lectern-transcription/SKILL.md',
      ),
      notesSkillPath: resolve(
        'packages/transcription/skills/lectern-notes/SKILL.md',
      ),
      concurrency: 5,
      intervalMs: 300_000,
      openCode: { executable: 'opencode', scratch: join(root, 'notes') },
      notesConcurrency: 2,
    },
    audio,
    notes,
  );
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    runtime,
    audioCalls: () => audioCalls,
    notesCalls: () => notesCalls,
    notesActive: () => notesActive,
  };
}
async function waitFor(runtime: OperatorRuntime, state: string) {
  for (let i = 0; i < 40; i++) {
    const status = await runtime.status();
    if (status.state === state) return status;
    await nextTurn();
  }
  assert.equal((await runtime.status()).state, state);
  throw new Error('unreachable');
}
void test('notes continue through Google quota exhaustion, manual resume and shutdown', async (t) => {
  const f = await fixture(t);
  await f.runtime.start();
  const waiting = await waitFor(f.runtime, 'waiting_quota');
  assert.equal(waiting.notes?.state, 'running');
  assert.equal(f.notesActive(), true);
  assert.equal(f.audioCalls(), 1);
  assert.equal(f.notesCalls(), 1);
  await f.runtime.start();
  await waitFor(f.runtime, 'running');
  assert.equal(f.audioCalls(), 2);
  assert.equal(
    f.notesCalls(),
    1,
    'resuming Google must not duplicate the notes worker',
  );
  await f.runtime.stop();
  assert.equal(f.notesActive(), false);
});
void test('restoring a saved Google quota wait starts only the independent notes worker', async (t) => {
  const f = await fixture(t, false, true);
  await f.runtime.restore();
  const waiting = await waitFor(f.runtime, 'waiting_quota');
  assert.equal(waiting.notes?.state, 'running');
  assert.equal(f.audioCalls(), 0);
  assert.equal(f.notesCalls(), 1);
});
void test('OpenCode authentication failure is reported while Google keeps running', async (t) => {
  const f = await fixture(t, true);
  await f.runtime.start();
  const status = await waitFor(f.runtime, 'running');
  assert.equal(status.notes?.state, 'error');
  assert.equal(status.notes?.error, 'auth_required');
  assert.equal(status.error, null);
  assert.equal(f.audioCalls(), 1);
});
void test('a shared database capacity failure from notes prevents new Google work', async (t) => {
  const f = await fixture(t, 'storage_exhausted');
  await assert.rejects(f.runtime.start(), { code: 'storage_exhausted' });
  const status = await f.runtime.status();
  assert.equal(status.state, 'error');
  assert.equal(status.error, 'storage_exhausted');
  assert.equal(f.audioCalls(), 0);
});
