import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({
  entryPoints: ['lib/library.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { readLibrary, serializeLibrary } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
const shiur = {
  id: 42,
  title: 'Fixture',
  teacher: 'Fixture',
  topics: [],
  duration: 120,
  audio: 'https://example.test/audio.mp3',
};
function storage(t, getItem) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
}
void test('normalized persistence migrates v1 and deduplicates metadata without changing collections or progress', (t) => {
  let stored = JSON.stringify({
    saved: [shiur],
    queue: [shiur],
    last: shiur,
    history: [
      { shiur, seconds: 42, duration: 120, updatedAt: '2026-10-05T00:00:00Z' },
    ],
    playlists: [{ id: 'fixture', name: 'Fixture', items: [shiur] }],
    speed: 1.5,
    volume: 0.4,
  });
  storage(t, () => stored);
  const legacy = readLibrary();
  stored = serializeLibrary(legacy);
  assert.equal(JSON.parse(stored).version, 2);
  assert.deepEqual(Object.keys(JSON.parse(stored).recordings), ['42']);
  assert.deepEqual(readLibrary(), legacy);
});
void test('restore bounds history and preserves an existing library beyond new membership limits', (t) => {
  const saved = Array.from({ length: 5001 }, (_, i) => ({
    ...shiur,
    id: i + 1,
  }));
  const stored = JSON.stringify({
    saved,
    history: saved
      .slice(0, 210)
      .map((s) => ({ shiur: s, seconds: 1, duration: 120 })),
  });
  storage(t, () => stored);
  assert.equal(readLibrary().saved.length, 5001);
  assert.equal(readLibrary().history.length, 200);
});
void test('disabled storage still restores a usable in-memory library', (t) => {
  storage(t, () => {
    throw new Error('Storage disabled');
  });
  assert.deepEqual(readLibrary().saved, []);
  assert.equal(readLibrary().speed, 1);
});
void test('default playback speed migrates from legacy speed and persists independently', (t) => {
  let stored = JSON.stringify({ speed: 1.5 });
  storage(t, () => stored);
  assert.equal(readLibrary().defaultSpeed, 1.5);
  stored = serializeLibrary({ ...readLibrary(), speed: 2, defaultSpeed: 1.25 });
  assert.equal(readLibrary().speed, 2);
  assert.equal(readLibrary().defaultSpeed, 1.25);
  stored = JSON.stringify({ speed: 1.5, defaultSpeed: 99 });
  assert.equal(readLibrary().defaultSpeed, 1);
});
void test('speeds through 3× survive persistence and invalid speeds restore to normal', (t) => {
  let stored = '';
  storage(t, () => stored);
  for (const speed of [2.25, 2.5, 2.75, 3]) {
    stored = serializeLibrary({ ...readLibrary(), speed, defaultSpeed: speed });
    assert.equal(readLibrary().speed, speed);
    assert.equal(readLibrary().defaultSpeed, speed);
  }
  for (const speed of [0, 0.5, 2.6, 3.25]) {
    stored = JSON.stringify({ speed, defaultSpeed: speed });
    assert.equal(readLibrary().speed, 1);
    assert.equal(readLibrary().defaultSpeed, 1);
  }
});
