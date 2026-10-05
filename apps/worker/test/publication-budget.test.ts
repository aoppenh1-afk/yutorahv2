import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublicationBudget } from '../../../packages/transcription/src/publication-budget.js';
import { WorkWake } from '../../../packages/transcription/src/work-wake.js';

void test('publication reservations survive restarts and concurrent publishers share the budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publication-budget-'));
  try {
    const file = join(root, 'usage.json');
    const first = new PublicationBudget(file, 100);
    const second = new PublicationBudget(file, 100);
    const write = {
      sql: 'INSERT INTO archive_segments VALUES(?,?,?,?,?,?,?,?,?)',
      params: Array(9).fill(''),
    };
    await Promise.all([first.reserve([write]), second.reserve([write])]);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).reserved, 100);
    await assert.rejects(
      new PublicationBudget(file, 100).reserve([write]),
      /daily write budget/,
    );
    await second.reserve([{ sql: 'SELECT * FROM archive_items', params: [] }]);
    const state = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...state, day: '2000-01-01' }));
    await second.reserve([write]);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).reserved, 50);
    second.observe({ size_after: 450 * 1024 * 1024 });
    await assert.rejects(second.reserve([write]), /storage budget/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test('durable work wakes all idle lanes and preserves a write preceding registration', async () => {
  const wake = new WorkWake();
  const signal = new AbortController();
  const observed = wake.revision;
  const waits = Array.from({ length: 5 }, () =>
    wake.wait(600000, signal.signal, observed),
  );
  wake.notify();
  await Promise.all(waits);
  await wake.wait(600000, signal.signal, observed);
  const waiting = wake.wait(600000, signal.signal);
  signal.abort(new Error('stopped'));
  await assert.rejects(waiting, /stopped/);
});
