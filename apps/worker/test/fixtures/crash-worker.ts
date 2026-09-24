import { Pool } from 'pg';
import { TranscriptionStore } from '../../../../packages/transcription/src/store.js';
import { transcribeChunks } from '../../../../packages/transcription/src/engine.js';
import { SessionPool } from '../../../../packages/antigravity-acp/src/pool.js';
import { runLeasedJob } from '../../src/worker.js';
const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  options: `-c search_path=${process.env.TEST_SCHEMA},public`,
});
const store = new TranscriptionStore(pool);
const job = await store.claim();
if (!job) throw new Error('Missing crash fixture job');
const ranges = Array.from({ length: 10 }, (_, i) => ({
  start: i * 10,
  end: (i + 1) * 10,
  coreStart: i * 10,
  coreEnd: (i + 1) * 10,
}));
await store.manifest(job, 'crash-fixture', 'audio', {
  version: 1,
  durationMs: 100000,
  ranges,
});
await store.stage(job, 'transcribing');
const cp = store.checkpoints(job, 'crash-fixture');
await runLeasedJob(
  store,
  job,
  new AbortController().signal,
  async (signal) => {
    await transcribeChunks({
      ranges,
      durationMs: 100000,
      settings: job.settings,
      pool: new SessionPool(1),
      signal,
      checkpoints: {
        load: cp.load,
        save: async (...args) => {
          await cp.save(...args);
          process.send?.({ saved: args[0] + 1, job: job.id });
        },
      },
      transcribe: async ({ index }) => {
        if (index >= 7) await new Promise(() => {});
        return `[00:01] Part${index}`;
      },
    });
  },
  1000,
);
