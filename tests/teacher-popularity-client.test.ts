import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTeacherPopularity } from '../lib/teacher-popularity-client';
import type { SearchResult } from '../lib/yutorah';

void test('teacher popularity requests a full scoped view ranking and resumes until complete', async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    hidden: false,
  }) as unknown as Document;
  t.after(() => {
    if (previousDocument) globalThis.document = previousDocument;
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const calls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input, 'https://example.test');
    if (url.pathname === '/api/teacher-popular')
      return new Response(null, { status: 204 });
    calls.push(url);
    return Response.json({
      items: [{ id: calls.length < 3 ? 1 : 181, views: 1000000 }],
      complete: calls.length === 3,
      scanned: calls.length < 3 ? 120 : 181,
      sourceTotal: 181,
      run: calls.length === 1 ? '' : 'teacher-run',
      retryAfterMs: 1,
    });
  });
  const results: SearchResult[] = [];
  await loadTeacherPopularity(80153, new AbortController().signal, (result) =>
    results.push(result),
  );
  assert.equal(calls.length, 3);
  for (const url of calls) {
    assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.get('teacher'), '80153');
    assert.equal(url.searchParams.get('q'), '');
    assert.equal(url.searchParams.get('sort'), 'popular');
    assert.equal(url.searchParams.get('page'), '1');
  }
  assert.equal(calls[1].searchParams.has('run'), false);
  assert.equal(calls[2].searchParams.get('run'), 'teacher-run');
  assert.deepEqual(
    results.map((result) => result.complete),
    [false, false, true],
  );
  assert.equal(results[2].items[0].id, 181);
});

void test('leaving a teacher stops delivery of an in-flight ranking', async (t) => {
  const controller = new AbortController();
  let finish!: (response: Response) => void;
  t.mock.method(
    globalThis,
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const results: SearchResult[] = [];
  const pending = loadTeacherPopularity(8, controller.signal, (result) =>
    results.push(result),
  );
  controller.abort();
  finish(Response.json({ items: [], complete: true }));
  await pending;
  assert.equal(results.length, 0);
});

void test('ranking failures reach the retry UI instead of falling back to the shortlist', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'Upstream unavailable' }, { status: 502 }),
  );
  await assert.rejects(
    loadTeacherPopularity(8, new AbortController().signal, () => {
      assert.fail('No ranking was loaded');
    }),
    /Upstream unavailable/,
  );
});

void test('prepared teacher rankings appear without scanning the archive and are shared on repeat visits', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    assert.match(input, /^\/api\/teacher-popular\?/);
    calls++;
    return Response.json({
      complete: true,
      preparedAt: Date.now(),
      items: [{ id: 100, views: 1000 }],
    });
  });
  const results: SearchResult[] = [];
  for (let visit = 0; visit < 2; visit++)
    await loadTeacherPopularity(99877, new AbortController().signal, (result) =>
      results.push(result),
    );
  assert.equal(calls, 1);
  assert.equal(results.length, 2);
  assert.equal(results[0].items[0].id, 100);
});
