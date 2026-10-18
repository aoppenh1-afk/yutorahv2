import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../app/api/shiur/route';
import { mergeShiurDetails } from '../lib/shiur-detail-client';
import { normalize, type Shiur } from '../lib/yutorah';
void test('core detail responses expose supplied audio and materials without requesting optional metadata', async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    paths.push(path);
    assert.ok(
      path.endsWith('/shiur/details'),
      'Optional metadata must not delay a core response',
    );
    return Response.json({
      shiurID: 998841,
      shiurTitle: 'Ready to play',
      shiurFileURL: 'https://example.test/audio.mp3',
      shiurMaterials: [
        { name: 'Source sheet', url: 'https://example.test/source.pdf' },
      ],
    });
  });
  const response = await GET(
    new Request('https://example.test/api/shiur?id=998841&part=core'),
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.audio, 'https://example.test/audio.mp3');
  assert.equal(data.materials[0].url, 'https://example.test/source.pdf');
  assert.equal(paths.length, 1);
});
void test('late detail enrichment preserves supplied collection membership and a real zero view count', () => {
  const previous: Shiur = {
    ...normalize({ shiurID: 99 }),
    views: 0,
    collections: [{ id: 1, name: 'Course' }],
    topics: ['Tefillah'],
  };
  const merged = mergeShiurDetails(previous, {
    ...normalize({ shiurID: 99 }),
    collections: [],
    topics: [],
  });
  assert.equal(merged.views, 0);
  assert.deepEqual(merged.collections, previous.collections);
  assert.deepEqual(merged.topics, previous.topics);
});
