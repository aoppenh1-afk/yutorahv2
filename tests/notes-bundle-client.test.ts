import test from 'node:test';
import assert from 'node:assert/strict';
import { gatherNotesBundle } from '../lib/notes-bundle-client';
const version = 'c'.repeat(64);
void test('whole collection notes visit every page using the first immutable membership version', async (t) => {
  const pages: number[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input, 'https://example.test');
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    assert.equal(url.searchParams.get('version'), page === 1 ? null : version);
    return Response.json({
      version,
      page,
      pages: 3,
      total: 121,
      scanned: page === 3 ? 21 : 50,
      done: page === 3,
      items: [
        {
          id: page,
          title: `Lesson ${page}`,
          teacher: 'Teacher',
          date: `2026-01-0${page}`,
          markdown: `Notes ${page}`,
        },
      ],
    });
  });
  const progress: number[] = [];
  const notes = await gatherNotesBundle(
    'collection',
    12,
    new AbortController().signal,
    (p) => {
      if (p.phase === 'gathering') progress.push(p.scanned);
    },
  );
  assert.deepEqual(
    pages.sort((a, b) => a - b),
    [1, 2, 3],
  );
  assert.deepEqual(
    notes.map((note) => note.id),
    [1, 2, 3],
  );
  assert.equal(progress.at(-1), 121);
});
void test('a changed or expired collection snapshot fails the download instead of exporting partial notes', async (t) => {
  for (const expired of [false, true]) {
    t.mock.method(globalThis, 'fetch', async (input: string) => {
      const page = Number(
        new URL(input, 'https://example.test').searchParams.get('page'),
      );
      if (page > 1 && expired)
        return Response.json(
          { error: 'This collection has updated. Restart the notes download.' },
          { status: 409 },
        );
      return Response.json({
        version: page === 1 ? version : 'd'.repeat(64),
        page,
        pages: 2,
        total: 51,
        scanned: page === 1 ? 50 : 1,
        done: page === 2,
        items: [
          {
            id: page,
            title: 'Lesson',
            teacher: '',
            date: '',
            markdown: 'Notes',
          },
        ],
      });
    });
    await assert.rejects(
      gatherNotesBundle(
        'collection',
        12,
        new AbortController().signal,
        () => {},
      ),
      /Restart the notes download/,
    );
  }
});
