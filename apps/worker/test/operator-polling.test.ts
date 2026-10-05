import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStatusPoller,
  statusPollInterval,
} from '../public/operator-polling.js';

function timers() {
  let sequence = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  return {
    tasks,
    setTimer: ((callback: () => void, delay: number) => {
      const id = ++sequence;
      tasks.set(id, { callback, delay });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => {
      tasks.delete(id);
    }) as unknown as typeof clearTimeout,
  };
}

void test('operator reads stop while hidden and resume immediately when visible', async () => {
  const clock = timers();
  let visible = false,
    calls = 0,
    state = 'stopped';
  const poller = createStatusPoller({
    read: async () => {
      calls++;
    },
    isVisible: () => visible,
    intervalMs: () => statusPollInterval(state, 0),
    ...clock,
  });
  poller.visibilityChanged();
  await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(clock.tasks.size, 0);
  visible = true;
  poller.visibilityChanged();
  await poller.refresh();
  assert.equal(calls, 1);
  assert.equal([...clock.tasks.values()][0].delay, 60_000);
  visible = false;
  poller.visibilityChanged();
  assert.equal(clock.tasks.size, 0);
  visible = true;
  state = 'running';
  poller.visibilityChanged();
  await poller.refresh();
  assert.equal(calls, 2);
  assert.equal([...clock.tasks.values()][0].delay, 10_000);
});

void test('manual refreshes share a slow read and do not schedule more work after hiding', async () => {
  const clock = timers();
  let visible = true,
    calls = 0;
  let resolve!: () => void;
  const wait = new Promise<void>((r) => {
    resolve = r;
  });
  const poller = createStatusPoller({
    read: async () => {
      calls++;
      await wait;
    },
    isVisible: () => visible,
    intervalMs: () => 10_000,
    ...clock,
  });
  const first = poller.refresh(),
    second = poller.refresh();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(clock.tasks.size, 0);
  visible = false;
  poller.visibilityChanged();
  resolve();
  await Promise.all([first, second]);
  assert.equal(clock.tasks.size, 0);
});

void test('failed operator reads back off and manual refresh can recover immediately', async () => {
  const clock = timers();
  let failures = 0,
    fail = true;
  const poller = createStatusPoller({
    read: async () => {
      if (fail) {
        failures++;
        throw new Error('Unavailable');
      }
      failures = 0;
    },
    isVisible: () => true,
    intervalMs: () => statusPollInterval('running', failures),
    ...clock,
  });
  for (let i = 1; i <= 8; i++) {
    await assert.rejects(poller.refresh(), /Unavailable/);
    assert.equal(clock.tasks.size, 1);
    assert.equal(
      [...clock.tasks.values()][0].delay,
      Math.min(300_000, 30_000 * 2 ** Math.min(i - 1, 4)),
    );
  }
  fail = false;
  await poller.refresh();
  assert.equal([...clock.tasks.values()][0].delay, 10_000);
});
