import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execFile = promisify(execFileCallback);
void test(
  'catalog discovery works through the managed VM network and checkpoints a full page',
  { skip: !process.env.NOTES_VM_RUNNER },
  async (t) => {
    const state = await mkdtemp(join(tmpdir(), 'notes-catalog-'));
    t.after(() => rm(state, { recursive: true, force: true }));
    await execFile(
      process.env.NOTES_VM_RUNNER,
      ['catalog', '--pages', '1', '--state', state],
      { timeout: 60000 },
    );
    const queue = new DatabaseSync(join(state, 'queue.sqlite'));
    try {
      assert.equal(
        queue.prepare('SELECT COUNT(*) AS count FROM jobs').get().count,
        30,
      );
      assert.equal(
        queue.prepare("SELECT value FROM cursors WHERE name='catalog'").get()
          .value,
        2,
      );
    } finally {
      queue.close();
    }
  },
);
