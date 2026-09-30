import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogRecords, scanHomepage } from '../src/catalog.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import {
  profile,
  type TranscriptionStore,
} from '../../../packages/transcription/src/store.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';

const uploads = [
  { shiurID: 1190283, shiurDate: '2026-09-30T00:00:00', shiurMediaType: 'MP3' },
  { shiurID: 1190282, shiurDate: '2026-09-29T00:00:00', shiurMediaType: 'MP3' },
  { shiurID: 1190281, shiurDate: '2026-09-30T00:00:00', shiurMediaType: 'MP3' },
];

void test('homepage discovery accepts upload order when recording dates differ', async () => {
  const ids: string[] = [];
  const store = {
    enqueue: async ({ id }: { id: string }) => {
      ids.push(id);
      return id;
    },
  } as unknown as TranscriptionStore;
  const count = await scanHomepage(
    store,
    profile('full skill', defaultSettings, 'fixture'),
    new AbortController().signal,
    async () => uploads,
  );
  assert.equal(count, 3);
  assert.deepEqual(ids, ['1190283', '1190282', '1190281']);
});

void test('paged catalog still rejects changed publication ordering and invalid dates', () => {
  assert.throws(
    () => catalogRecords(uploads),
    (error: unknown) => error instanceof Failure && error.code === 'download',
  );
  assert.throws(
    () => catalogRecords([{ ...uploads[0], shiurDate: 'invalid' }]),
    (error: unknown) => error instanceof Failure && error.code === 'download',
  );
});
