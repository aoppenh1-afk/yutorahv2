import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runWorker, runLeasedJob } from '../src/worker.js';
import { prepareProfile } from '../../../packages/antigravity-acp/src/runtime.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import type { TranscriptionStore } from '../../../packages/transcription/src/store.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

for (const scenario of [
  'leadership_loss',
  'unavailable_model',
  'storage_full',
] as const) {
  void test(`worker rejects ${scenario} before claiming jobs`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-startup-'));
    const marker = join(root, 'ready');
    const leader = new EventEmitter() as EventEmitter & {
      query: () => Promise<unknown>;
      release: () => void;
    };
    let released = false;
    leader.query = async () => ({ rows: [{ acquired: true }] });
    leader.release = () => {
      released = true;
    };
    const store = {
      pool: { connect: async () => leader },
      claim: async () => {
        if (scenario === 'storage_full')
          throw Object.assign(new Error('project size limit exceeded'), {
            code: '53100',
          });
        assert.fail('startup failure must not consume jobs');
      },
    } as unknown as TranscriptionStore;
    const controller = new AbortController();
    let running: Promise<void> | undefined;
    try {
      await prepareProfile(join(root, 'profile'));
      await writeFile(
        join(root, 'agy_acp_server.par'),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('apps/worker/test/fixtures/acp.mjs'))} ready_on_close ${quote(marker)}\n`,
        { mode: 0o700 },
      );
      running = runWorker(
        store,
        {
          runtime: {
            directory: root,
            profile: join(root, 'profile'),
            scratch: join(root, 'scratch'),
          },
          concurrency: 1,
          pollMs: 100,
          model:
            scenario === 'unavailable_model'
              ? 'not-advertised'
              : 'gemini-3.8-flash-high',
        },
        controller.signal,
      );
      const outcome = running.then(
        () => null,
        (error: unknown) => error,
      );
      if (scenario === 'leadership_loss') {
        let ready = false;
        for (let i = 0; i < 500; i++) {
          if ((await readFile(marker, 'utf8').catch(() => '')) === 'ready') {
            ready = true;
            break;
          }
          await delay(10);
        }
        assert.ok(ready, 'runtime must finish its preflight');
        leader.emit(
          'error',
          new Error('connection lost during runtime cleanup'),
        );
      }
      const error = await outcome;
      assert.ok(error instanceof Failure);
      assert.equal(
        error.code,
        scenario === 'leadership_loss'
          ? 'lease_lost'
          : scenario === 'storage_full'
            ? 'storage_exhausted'
            : 'configuration',
      );
      assert.equal(released, true);
    } finally {
      controller.abort(new Failure('cancelled'));
      await running?.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

void test('database capacity failures stop leased work without failing the recording', async () => {
  const job = { id: 'capacity-test' };
  let result: { code: string; requeue: boolean } | undefined;
  await assert.rejects(
    runLeasedJob(
      {
        heartbeat: async () => {},
        finishFailure: async (_job, code, requeue) => {
          result = { code, requeue };
        },
      },
      job,
      new AbortController().signal,
      async () => {
        throw Object.assign(new Error('project size limit exceeded'), {
          code: '53100',
        });
      },
    ),
    (error: unknown) =>
      error instanceof Failure && error.code === 'storage_exhausted',
  );
  assert.deepEqual(result, { code: 'storage_exhausted', requeue: true });
});
