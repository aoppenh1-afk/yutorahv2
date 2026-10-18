import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCollectionItems } from '../lib/collection-client';
import { normalize } from '../lib/yutorah';
const version = 'a'.repeat(64);
void test('Add all gathers every pinned page instead of the currently visible slice', async (t) => {
  const ids: number[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input, 'https://example.test');
    assert.equal(url.searchParams.get('version'), version);
    assert.equal(url.searchParams.get('q'), '');
    assert.equal(url.searchParams.get('sort'), 'old');
    const offset = Number(url.searchParams.get('offset'));
    ids.push(offset);
    return Response.json({
      version,
      count: 121,
      offset,
      next: offset + 60 < 121 ? offset + 60 : null,
      items: Array.from({ length: Math.min(60, 121 - offset) }, (_, i) =>
        normalize({ shiurID: offset + i + 1 }),
      ),
    });
  });
  const all = await loadCollectionItems(99761, version);
  assert.deepEqual(ids, [0, 60, 120]);
  assert.deepEqual(
    all.map((s) => s.id),
    Array.from({ length: 121 }, (_, i) => i + 1),
  );
});
void test('changed generations and incomplete pages never become a complete queue', async (t) => {
  for (const id of [99762, 99763]) {
    t.mock.method(globalThis, 'fetch', async (input: string) => {
      const offset = Number(
        new URL(input, 'https://example.test').searchParams.get('offset'),
      );
      return Response.json({
        version: id === 99762 && offset ? 'b'.repeat(64) : version,
        count: 61,
        offset,
        next: offset ? null : 60,
        items: offset
          ? []
          : Array.from({ length: 60 }, (_, i) => normalize({ shiurID: i + 1 })),
      });
    });
    await assert.rejects(
      loadCollectionItems(id, version),
      /changed|incomplete/,
    );
  }
});
