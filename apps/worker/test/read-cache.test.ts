import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCachedTranscriptReader,
  type TranscriptReader,
} from '../../../packages/transcription/src/read-cache.js';
import { transcriptDatabaseGateway } from '../../../lib/transcript-database.js';

const fixture = (id: string, text = 'A published transcript') => ({
  id,
  title: 'Fixture',
  teacher: 'Rabbi Fixture',
  transcriptId: 'version-1',
  text,
  durationMs: 1000,
  createdAt: '2026-10-04T00:00:00Z',
  segments: [],
  notes: null,
});

void test('concurrent website reads use one database query and return separate usable responses', async () => {
  let calls = 0;
  const source: TranscriptReader = {
    content: async (id) => {
      calls++;
      return fixture(id);
    },
    search: async () => [],
  };
  const requests = Array.from({ length: 20 }, () =>
    transcriptDatabaseGateway(
      '/v1/transcripts/1',
      new URLSearchParams(),
      source,
    ),
  );
  const responses = await Promise.all(requests);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('Cache-Control'),
      'public, max-age=0, s-maxage=60',
    );
    assert.deepEqual(await response.json(), fixture('1'));
  }
  await transcriptDatabaseGateway(
    '/v1/transcripts/1',
    new URLSearchParams(),
    source,
  );
  assert.equal(calls, 1);
});

void test('reads expire without extending their age; search options keep distinct results', async () => {
  let now = 0,
    contentCalls = 0,
    searchCalls = 0;
  const reader = createCachedTranscriptReader(
    {
      content: async (id) => {
        contentCalls++;
        return fixture(id);
      },
      search: async () => {
        searchCalls++;
        return [];
      },
    },
    { now: () => now },
  );
  await reader.content('1');
  now = 59_999;
  await reader.content('1');
  assert.equal(contentCalls, 1);
  now = 60_000;
  await reader.content('1');
  assert.equal(contentCalls, 2);
  await reader.search('coffee', true, 20, 'smart');
  await reader.search('coffee', true, 20, 'smart');
  assert.equal(searchCalls, 1);
  await reader.search('coffee', false, 20, 'smart');
  await reader.search('coffee', true, 10, 'smart');
  await reader.search('coffee', true, 20, 'phrase');
  assert.equal(searchCalls, 4);
  now += 15_000;
  await reader.search('coffee', true, 20, 'smart');
  assert.equal(searchCalls, 5);
});

void test('missing transcripts and failed database reads recover on the next request', async () => {
  let calls = 0;
  let available = false;
  const source: TranscriptReader = {
    content: async (id) => {
      calls++;
      if (id === '2' && !available)
        throw new Error('private connection detail');
      return available ? fixture(id) : null;
    },
    search: async () => [],
  };
  for (const id of ['1', '1', '2', '2']) {
    const response = await transcriptDatabaseGateway(
      `/v1/transcripts/${id}`,
      new URLSearchParams(),
      source,
    );
    assert.equal(response.status, id === '1' ? 404 : 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(
      JSON.stringify(await response.json()).includes('private'),
      false,
    );
  }
  assert.equal(calls, 4);
  available = true;
  for (const id of ['1', '2']) {
    const response = await transcriptDatabaseGateway(
      `/v1/transcripts/${id}`,
      new URLSearchParams(),
      source,
    );
    assert.equal(response.status, 200);
  }
  assert.equal(calls, 6);
});

void test('cache eviction respects recent usage, entry count, and UTF-8 byte limits', async () => {
  const calls: string[] = [];
  const source: TranscriptReader = {
    content: async (id) => {
      calls.push(id);
      return fixture(id, 'שלום');
    },
    search: async () => [],
  };
  const reader = createCachedTranscriptReader(source, { maxEntries: 2 });
  for (const id of ['1', '2', '1', '3', '2']) await reader.content(id);
  assert.deepEqual(calls, ['1', '2', '3', '2']);
  calls.length = 0;
  const bytes = Buffer.byteLength(JSON.stringify(fixture('1', 'שלום'))) + 1;
  const bounded = createCachedTranscriptReader(source, { maxBytes: bytes });
  for (const id of ['1', '2', '1']) await bounded.content(id);
  assert.deepEqual(calls, ['1', '2', '1']);
  calls.length = 0;
  const oversized = createCachedTranscriptReader(source, {
    maxBytes: bytes - 1,
  });
  await oversized.content('1');
  await oversized.content('1');
  assert.deepEqual(calls, ['1', '1']);
});

void test('pending reads share work while distinct pending keys stay bounded', async () => {
  let resolve!: () => void;
  const wait = new Promise<void>((r) => {
    resolve = r;
  });
  const calls: string[] = [];
  const reader = createCachedTranscriptReader(
    {
      content: async (id) => {
        calls.push(id);
        await wait;
        return fixture(id);
      },
      search: async () => [],
    },
    { maxPending: 1 },
  );
  const first = reader.content('1');
  const shared = reader.content('1');
  const second = reader.content('2');
  await Promise.resolve();
  assert.deepEqual(calls.sort(), ['1', '2']);
  resolve();
  assert.deepEqual(await first, await shared);
  await second;
});
