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
  shiurvisitsnum: i === 179 ? 1000000 : i * 10,
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

void test('learning title vocabulary cannot change a resumed search expansion or its pagination', async () => {
  const titleCompiled = await build({
    entryPoints: ['lib/title-index.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  });
  const { indexTitleStatements } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(titleCompiled.outputFiles[0].text).toString('base64')
  );
  const db = database();
  const first = await completeSearch(db, 'cris pix', {});
  const original = JSON.parse(
    (
      await db
        .prepare('SELECT plan FROM search_runs WHERE id=?')
        .bind(first.run)
        .first()
    ).plan,
  );
  await db.batch(
    indexTitleStatements(db, [{ id: 999, title: 'The Beracha on Crispix' }]),
  );
  const resumed = await completeSearch(db, 'cris pix', {}, 1, first.run);
  assert.equal(resumed.run, first.run);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.plan.term, original.searchTerm);
  const stored = JSON.parse(
    (
      await db
        .prepare('SELECT plan FROM search_runs WHERE id=?')
        .bind(first.run)
        .first()
    ).plan,
  );
  assert.deepEqual(stored.vocabulary, original.vocabulary);
  assert.equal(stored.sourceQuery, original.sourceQuery);
  assert.equal(resumed.sourceTotal, 181);
  await db.prepare('DELETE FROM search_runs WHERE id=?').bind(first.run).run();
  const fresh = await completeSearch(db, 'cris pix', {});
  assert.equal(
    fresh.plan.term,
    'cris pix',
    'The UI must resume with the same parsed request',
  );
  assert.ok(
    fresh.plan.labels.some((label) => label.includes('cris pix → crispix')),
  );
  const repaired = JSON.parse(
    (
      await db
        .prepare('SELECT plan FROM search_runs WHERE id=?')
        .bind(fresh.run)
        .first()
    ).plan,
  );
  assert.equal(repaired.searchTerm, 'crispix');
  const continued = await completeSearch(db, fresh.plan.term, {}, 1, fresh.run);
  assert.equal(continued.run, fresh.run);
  assert.equal(continued.complete, true);
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

void test('most popular ranks every matching candidate by views after applying refinements', async () => {
  const db = database();
  const options = { sort: 'popular', language: 'EN', max: 20 };
  let result = await completeSearch(db, 'teshuva', options);
  while (!result.complete)
    result = await completeSearch(db, 'teshuva', options, 1, result.run);
  assert.equal(
    result.items[0].id,
    181,
    'Includes the most viewed match on the last page',
  );
  assert.equal(result.total, 10);
  assert.ok(
    result.items.every((s) => s.language === 'EN' && s.duration <= 1200),
  );
  assert.ok(
    !result.items.some((s) => s.id === 180),
    'Excludes the more viewed Hebrew shiur',
  );
  assert.deepEqual(
    result.items.map((s) => s.views),
    result.items.map((s) => s.views).sort((a, b) => b - a),
  );
  const titleOnly = await completeSearch(db, 'teshuva', {
    sort: 'popular',
    scope: 'title',
  });
  assert.deepEqual(
    titleOnly.items.map((s) => s.id),
    [181],
  );
  const hebrew = await completeSearch(db, 'teshuva', {
    sort: 'popular',
    language: 'HE',
  });
  assert.equal(hebrew.items[0].id, 180);
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

void test('submitted partial misspellings retrieve real candidates and retain fuzzy title refinements across every page', async () => {
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

void test('intent expansion retrieves and ranks related archive content, with strict filters still enforced', async () => {
  const { completeSearch: intentSearch } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64') +
      '#intent'
  );
  const fixtureFetch = globalThis.fetch;
  const requests = [];
  const candidates = [
    {
      ...records[0],
      shiurid: 3000,
      shiurtitle: 'Dealing with Anxiety',
      shiurdescription: '',
      duration: 15,
    },
    {
      ...records[0],
      shiurid: 3001,
      shiurtitle: 'Building Bitachon',
      shiurdescription: '',
      duration: 15,
    },
    {
      ...records[0],
      shiurid: 3002,
      shiurtitle: 'Other lecture',
      shiurdescription: 'A discussion of bitachon',
      duration: 15,
    },
    {
      ...records[0],
      shiurid: 3003,
      shiurtitle: 'Bitachon',
      shiurdescription: '',
      duration: 45,
    },
  ];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    const query = url.searchParams.get('searchTerm');
    requests.push(query);
    const hits = query.includes('bitachon') ? candidates : [];
    return Response.json({ response: { numFound: hits.length, docs: hits } });
  };
  try {
    const db = database();
    const result = await intentSearch(db, "I'm struggling with anxiety", {
      max: 20,
    });
    assert.equal(result.complete, true);
    assert.equal(result.sourceTotal, 4);
    assert.equal(result.total, 3);
    assert.deepEqual(
      result.items.map((item) => item.id),
      [3000, 3001, 3002],
    );
    assert.ok(
      result.plan.labels.some((label) => label.startsWith('Related topics:')),
    );
    assert.ok(
      requests.every(
        (query) => query.includes('anxiety') && query.includes('bitachon'),
      ),
    );
    const calls = requests.length;
    const title = await intentSearch(db, "I'm struggling with anxiety", {
      max: 20,
      scope: 'title',
    });
    assert.equal(title.run, result.run);
    assert.deepEqual(
      title.items.map((item) => item.id),
      [3000, 3001],
    );
    const literal = await intentSearch(db, "I'm struggling with anxiety", {
      max: 20,
      phrase: 'anxiety',
    });
    assert.deepEqual(
      literal.items.map((item) => item.id),
      [3000],
    );
    assert.equal(requests.length, calls);
  } finally {
    globalThis.fetch = fixtureFetch;
  }
});

void test('a zero-result query recovers related candidates and resumes the same strategy with strict refinements', async () => {
  const { completeSearch: recoveredSearch } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64') +
      '#recovery'
  );
  const fixtureFetch = globalThis.fetch;
  const queries = [];
  const candidates = records.map((record, i) => ({
    ...record,
    shiurid: 4000 + i,
    shiurtitle: i === 180 ? 'Tefillah on Shabbos' : 'Tefillah',
    shiurdescription: 'Shabbat',
  }));
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    const query = url.searchParams.get('searchTerm');
    queries.push(query);
    assert.equal(url.searchParams.get('teacherID'), '1');
    const hits = query.includes('practical') ? [] : candidates;
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
    const query = 'practical tefillah shabbat';
    const filters = { teacherId: 1, language: 'EN', max: 5, scope: 'title' };
    let result = await recoveredSearch(db, query, filters);
    assert.equal(result.related, true);
    assert.equal(result.complete, false);
    assert.equal(result.scanned, 120);
    assert.equal(
      queries.filter((term) => term.includes('practical')).length,
      1,
    );
    const run = result.run;
    result = await recoveredSearch(db, query, filters, 1, run);
    assert.equal(result.related, true);
    assert.equal(result.complete, true);
    assert.equal(result.run, run);
    assert.equal(result.sourceTotal, 181);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, 4180);
    assert.equal(result.plan.original, query);
    assert.ok(
      result.plan.labels.some((label) => label.startsWith('Broadened search:')),
    );
    const calls = queries.length;
    const relaxedScope = await recoveredSearch(db, query, {
      ...filters,
      scope: '',
    });
    assert.equal(relaxedScope.run, run);
    assert.equal(relaxedScope.total, 3);
    assert.equal(
      relaxedScope.items[0].id,
      4180,
      'Complete title coverage outranks partial titles',
    );
    const exact = await recoveredSearch(db, query, {
      ...filters,
      phrase: 'practical',
    });
    assert.equal(exact.total, 0);
    assert.equal(exact.run, run);
    assert.equal(queries.length, calls);
    const quoted = await recoveredSearch(
      db,
      '"practical tefillah shabbat"',
      filters,
    );
    assert.equal(quoted.related, false);
    assert.equal(quoted.total, 0);
  } finally {
    globalThis.fetch = fixtureFetch;
  }
});

void test('recovery never replaces source errors or broadens an existing candidate set after refinements', async () => {
  const { completeSearch: guardedSearch } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64') +
      '#guarded-recovery'
  );
  const fixtureFetch = globalThis.fetch;
  const queries = [];
  let fail = true;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    queries.push(url.searchParams.get('searchTerm'));
    if (fail) return new Response('Unavailable', { status: 503 });
    return Response.json({ response: { numFound: 1, docs: [records[0]] } });
  };
  try {
    const db = database();
    await assert.rejects(guardedSearch(db, 'practical tefillah shabbat', {}));
    assert.equal(queries.length, 1);
    assert.ok(queries[0].includes('practical'));
    fail = false;
    queries.length = 0;
    const result = await guardedSearch(db, 'practical tefillah shabbat', {
      language: 'HE',
    });
    assert.equal(result.total, 0);
    assert.equal(result.sourceTotal, 1);
    assert.equal(result.related, false);
    assert.equal(
      queries.length,
      1,
      'The first source page is fetched once, with no fallback',
    );
    assert.ok(queries[0].includes('practical'));
  } finally {
    globalThis.fetch = fixtureFetch;
  }
});
