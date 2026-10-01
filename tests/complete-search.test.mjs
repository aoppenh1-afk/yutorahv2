import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
const compiled = await build({
  entryPoints: ['lib/complete-search.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { completeSearch } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  const prepare = (sql, values = []) => ({
    bind: (...args) => prepare(sql, args),
    first: async () => sqlite.prepare(sql).get(...values) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => ({
      meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) },
    }),
  });
  return {
    prepare,
    batch: async (statements) => {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
const records = Array.from({ length: 181 }, (_, i) => ({
  shiurid: i + 1,
  shiurtitle: i === 180 ? 'Teshuva' : `General lecture ${i}`,
  shiurdescription: 'teshuva',
  duration: 181 - i,
  language: i % 2 ? 'HE' : 'EN',
  shiurdate: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
  mediatypename: 'MP3',
  teacherfullname: 'Rabbi Example',
  teacherid: 1,
}));
let failPage = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.pathname.includes('/browse/')) return Response.json([]);
  const page = Number(url.searchParams.get('start') || 1);
  if (page === failPage) {
    failPage = 0;
    return new Response('Unavailable', { status: 503 });
  }
  return Response.json({
    response: {
      docs: records.slice((page - 1) * 30, page * 30),
      numFound: records.length,
    },
  });
};
test.after(() => {
  globalThis.fetch = realFetch;
});

void test('a match on the last upstream page ranks first; complete totals and pagination cover every candidate', async () => {
  const db = database();
  let result = await completeSearch(db, 'teshuva', { language: 'EN' });
  assert.equal(result.complete, false);
  assert.equal(result.scanned, 120);
  assert.equal(result.nextPage, null);
  result = await completeSearch(
    db,
    'teshuva',
    { language: 'EN' },
    1,
    result.run,
  );
  assert.equal(result.complete, true);
  assert.equal(result.sourceTotal, 181);
  assert.equal(result.total, 91);
  assert.equal(result.items[0].id, 181);
  const run = result.run;
  const short = await completeSearch(db, 'teshuva', {
    language: 'EN',
    sort: 'short',
  });
  const differentFilter = await completeSearch(db, 'teshuva', {
    language: 'HE',
    max: 20,
  });
  assert.equal(differentFilter.run, run);
  assert.equal(differentFilter.complete, true);
  assert.ok(
    differentFilter.items.every(
      (s) => s.language === 'HE' && s.duration <= 1200,
    ),
  );
  assert.equal(short.run, run);
  assert.equal(short.items[0].id, 181);
  const oldest = await completeSearch(db, 'teshuva', {
    language: 'EN',
    sort: 'old',
  });
  assert.equal(oldest.items[0].id, 1);
  const ids = [];
  for (let page = 1; page <= 4; page++) {
    const part = await completeSearch(
      db,
      'teshuva',
      { language: 'EN', sort: 'short' },
      page,
      run,
    );
    ids.push(...part.items.map((s) => s.id));
  }
  assert.equal(ids.length, 91);
  assert.equal(new Set(ids).size, 91);
});

void test('a failed upstream page does not advance the cursor and retry finishes the same run', async () => {
  const db = database();
  failPage = 5;
  const first = await completeSearch(db, 'retry-test', {});
  await assert.rejects(completeSearch(db, 'retry-test', {}, 1, first.run));
  const retry = await completeSearch(db, 'retry-test', {}, 1, first.run);
  assert.equal(retry.complete, true);
  assert.equal(retry.scanned, 181);
});

void test('an exhausted search with no matching records reports exact zero', async () => {
  const db = database();
  let result = await completeSearch(db, 'empty-test', {
    phrase: 'nonexistent',
  });
  while (!result.complete)
    result = await completeSearch(
      db,
      'empty-test',
      { phrase: 'nonexistent' },
      1,
      result.run,
    );
  assert.equal(result.total, 0);
  assert.equal(result.nextPage, null);
  assert.deepEqual(result.items, []);
});

void test('cached refinements enforce phrase, exclusion, title scope and date bounds with bound values', async () => {
  const db = database();
  let ready = await completeSearch(db, 'refinement-test', {});
  while (!ready.complete)
    ready = await completeSearch(db, 'refinement-test', {}, 1, ready.run);
  const phrase = await completeSearch(db, 'refinement-test', {
    phrase: 'GENERAL, LECTURE',
    max: 20,
  });
  assert.equal(phrase.run, ready.run);
  assert.equal(phrase.total, 19);
  const excluded = await completeSearch(db, 'refinement-test', {
    exclude: 'general',
  });
  assert.equal(excluded.total, 1);
  assert.equal(excluded.items[0].id, 181);
  const date = await completeSearch(db, 'refinement-test', {
    after: '2026-01-02',
    before: '2026-01-02',
  });
  assert.equal(date.total, 1);
  assert.equal(date.items[0].id, 2);
  const scope = await completeSearch(db, 'refinement-test', { scope: 'title' });
  assert.equal(scope.total, 0);
  const injection = await completeSearch(db, 'refinement-test', {
    phrase: "' OR 1=1 --",
  });
  assert.equal(injection.total, 0);
});

test('submitted partial misspellings retrieve real candidates and retain fuzzy title refinements across every page', async () => {
  // An isolated module has its own upstream cache, like a fresh worker isolate.
  const { completeSearch: smartSearch } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64') +
      '#smart'
  );
  const fixtureFetch = globalThis.fetch;
  const requests = [];
  const candidates = records.map((record, i) => ({
    ...record,
    shiurid: 2000 + i,
    shiurtitle: i === 180 ? 'Schachter' : 'General lecture',
    shiurdescription: 'A discussion referencing Schachter',
    teacherfullname: 'Rabbi Example',
  }));
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/browse/teachers'))
      return Response.json([
        {
          ID: 1,
          title: 'Rabbi',
          firstName: 'Hershel',
          lastName: 'Schachter',
          shiurCount: 7500,
        },
        {
          ID: 2,
          title: 'Rabbi',
          firstName: 'Shay',
          lastName: 'Schachter',
          shiurCount: 2000,
        },
      ]);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    requests.push(url.searchParams.get('searchTerm'));
    // This fixture's native index resolves "schachter"; keyword-only "schact"
    // cannot retrieve these records. Query construction is asserted separately.
    const hits = url.searchParams.get('searchTerm').includes('schachter')
      ? candidates
      : [];
    const page = Number(url.searchParams.get('start') || 1);
    return Response.json({
      response: {
        numFound: hits.length,
        docs: hits.slice((page - 1) * 30, page * 30),
      },
    });
  };
  try {
    const db = database();
    let result = await smartSearch(db, 'schact', { language: 'EN' });
    assert.equal(result.complete, false);
    while (!result.complete)
      result = await smartSearch(
        db,
        'schact',
        { language: 'EN' },
        1,
        result.run,
      );
    assert.equal(result.sourceTotal, 181);
    assert.equal(result.total, 91);
    assert.equal(result.items[0].id, 2180);
    assert.ok(
      requests.every(
        (query) =>
          query.includes('schact*') &&
          query.includes('schact~1') &&
          query.includes('schachter'),
      ),
    );
    const calls = requests.length;
    const title = await smartSearch(db, 'schact', { scope: 'title', max: 5 });
    assert.equal(title.run, result.run);
    assert.equal(title.total, 1);
    assert.equal(title.items[0].id, 2180);
    const literal = await smartSearch(db, 'schact', { phrase: 'schact' });
    assert.equal(literal.total, 0);
    assert.equal(
      requests.length,
      calls,
      'Refinements reuse the completed candidates',
    );
    const next = await smartSearch(
      db,
      'schact',
      { language: 'EN' },
      2,
      result.run,
    );
    assert.equal(next.items.length, 30);
    assert.ok(
      next.items.every(
        (item) => !result.items.some((first) => first.id === item.id),
      ),
    );
  } finally {
    globalThis.fetch = fixtureFetch;
  }
});
