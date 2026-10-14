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
const titleIndexCompiled = await build({
  entryPoints: ['lib/title-index.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { indexTitleStatements: indexFixtureTitles } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(titleIndexCompiled.outputFiles[0].text).toString('base64')
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
    return new Response('Invalid request', { status: 400 });
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

void test('an empty scoped search explicitly requests all matching lessons and retains upload metadata', async (t) => {
  const fixture = Array.from({ length: 35 }, (_, i) => ({
    shiurid: 2000 + i,
    shiurtitle: 'Lesson ' + i,
    teacherid: 1,
    teacherfullname: 'One',
    collectionid: [55555],
    collectionname: ['Course|55555'],
    shiurdate: '2011-01-01',
    shiurdatesubmitted:
      i === 34 ? '2026-10-12T12:00:00Z' : '2026-10-01T12:00:00Z',
    language: 'EN',
    mediatypename: 'MP3',
    duration: 20,
  }));
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    assert.equal(url.searchParams.get('collectionID'), '55555');
    assert.equal(url.searchParams.get('searchTerm'), '*');
    const page = Number(url.searchParams.get('start'));
    return Response.json({
      response: {
        docs: fixture.slice((page - 1) * 30, page * 30),
        numFound: fixture.length,
      },
    });
  });
  const db = database();
  const all = await completeSearch(db, '', { collectionId: 55555 });
  assert.equal(all.complete, true);
  assert.equal(all.total, 35);
  assert.equal(all.facets.collections[0].name, 'Course');
  const recent = await completeSearch(db, '', {
    collectionId: 55555,
    dateBasis: 'uploaded',
    after: '2026-10-12',
    before: '2026-10-12',
  });
  assert.equal(recent.run, all.run);
  assert.equal(recent.total, 1);
  assert.equal(recent.items[0].id, 2034);
});

void test('upload-date refinements and contextual counts cover coauthors on the final candidate page', async (t) => {
  const fixture = Array.from({ length: 65 }, (_, i) => ({
    shiurid: 1000 + i,
    shiurtitle: 'Metadata parity ' + i,
    shiurdescription: 'metadata parity',
    teacherid: i === 64 ? [1, 2, 2] : [1],
    teacherfullname: i === 64 ? ['One', 'Two', 'Two'] : ['One'],
    shiurdate: '2011-01-01T00:00:00Z',
    shiurdatesubmitted:
      i === 64 ? '2026-10-12T12:00:00Z' : '2026-10-01T12:00:00Z',
    subcategoryid: [10],
    subcategoryname: ['Kashrut'],
    categoryname: ['Halacha'],
    mediatypename: 'MP3',
    language: 'EN',
    duration: 20,
  }));
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    const page = Number(url.searchParams.get('start') || 1);
    return Response.json({
      response: {
        docs: fixture.slice((page - 1) * 30, page * 30),
        numFound: fixture.length,
      },
    });
  });
  const db = database();
  const upload = await completeSearch(db, 'metadata parity', {
    after: '2026-10-12',
    before: '2026-10-12',
    dateBasis: 'uploaded',
    group: 'Halacha',
  });
  assert.equal(upload.complete, true);
  assert.equal(upload.total, 1);
  assert.equal(upload.items[0].id, 1064);
  assert.deepEqual(
    upload.facets.teachers.map((t) => [t.id, t.count]),
    [
      [1, 1],
      [2, 1],
    ],
  );
  assert.equal(upload.facets.topics[0].count, 1);
  const given = await completeSearch(db, 'metadata parity', {
    after: '2026-10-12',
    before: '2026-10-12',
    dateBasis: 'given',
  });
  assert.equal(given.run, upload.run);
  assert.equal(given.total, 0);
  const all = await completeSearch(db, 'metadata parity', {});
  assert.equal(all.total, 65);
  assert.deepEqual(
    all.facets.teachers.map((t) => [t.id, t.count]),
    [
      [1, 65],
      [2, 1],
    ],
  );
});

void test('a stale pass rolls back hits, documents and title learning after a peer claims the lease', async () => {
  const raw = database();
  let stolen = false;
  const db = {
    ...raw,
    async batch(statements) {
      const run = await raw
        .prepare('SELECT * FROM search_runs WHERE lease>0')
        .first();
      if (run && !stolen) {
        stolen = true;
        await raw
          .prepare('UPDATE search_runs SET owner=?,lease=? WHERE id=?')
          .bind('peer-owner', Date.now() + 60000, run.id)
          .run();
      }
      return raw.batch(statements);
    },
  };
  await assert.rejects(completeSearch(db, 'teshuva', {}), /lost its lease/);
  const run = await raw.prepare('SELECT * FROM search_runs').first();
  assert.equal(run.next, 1);
  assert.equal(run.scanned, 0);
  assert.equal(run.owner, 'peer-owner');
  assert.ok(run.lease > Date.now());
  for (const table of [
    'search_hits',
    'search_documents',
    'search_title_catalog',
    'search_pass_guards',
  ])
    assert.equal(
      (await raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,
      0,
      table,
    );
  await raw.prepare('UPDATE search_runs SET lease=0').run();
  const resumed = await completeSearch({ ...raw }, 'teshuva', {}, 1, run.id);
  assert.equal(resumed.scanned, 120);
  assert.equal(resumed.complete, false);
});

void test('expiry without another claimant rejects every mutation using the database clock', async () => {
  const raw = database();
  const db = {
    ...raw,
    async batch(statements) {
      await raw.prepare('UPDATE search_runs SET lease=1 WHERE lease>0').run();
      return raw.batch(statements);
    },
  };
  await assert.rejects(completeSearch(db, 'teshuva', {}), /lost its lease/);
  assert.equal(
    (await raw.prepare('SELECT COUNT(*) AS n FROM search_hits').first()).n,
    0,
  );
  assert.equal(
    (await raw.prepare('SELECT scanned FROM search_runs').first()).scanned,
    0,
  );
});

void test('cold concurrent callers share one durable scan across database wrappers', async (t) => {
  const db = database();
  const peer = { ...db };
  let pages = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    pages++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const page = Number(url.searchParams.get('start'));
    return Response.json({
      response: {
        docs: records.slice((page - 1) * 30, page * 30),
        numFound: records.length,
      },
    });
  });
  const results = await Promise.all([
    completeSearch(db, 'teshuva', {}),
    completeSearch(peer, 'teshuva', {}),
  ]);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) AS n FROM search_runs').first()).n,
    1,
  );
  assert.equal(
    (await db.prepare('SELECT COUNT(*) AS n FROM search_hits').first()).n,
    120,
  );
  assert.equal(pages, 4);
  const first = results.find((result) => result.run);
  const completed = await completeSearch(peer, 'teshuva', {}, 1, first.run);
  assert.equal(completed.complete, true);
  assert.equal(completed.scanned, 181);
  assert.equal(pages, 7);
});

void test('overlapping scans share immutable documents and warmed completed pages need no SQL', async () => {
  const raw = database();
  let reads = 0;
  const db = {
    ...raw,
    prepare(sql) {
      reads++;
      return raw.prepare(sql);
    },
  };
  let first = await completeSearch(db, 'teshuva', {});
  first = await completeSearch(db, 'teshuva', {}, 1, first.run);
  let second = await completeSearch(db, 'quantum', {});
  second = await completeSearch(db, 'quantum', {}, 1, second.run);
  assert.equal(
    (await raw.prepare('SELECT COUNT(*) AS n FROM search_documents').first()).n,
    181,
  );
  assert.equal(
    (await raw.prepare('SELECT COUNT(*) AS n FROM search_hits').first()).n,
    362,
  );
  assert.equal(
    (
      await raw
        .prepare("SELECT COUNT(*) AS n FROM search_hits WHERE payload<>''")
        .first()
    ).n,
    0,
  );
  const usage = await raw
    .prepare("SELECT bytes FROM search_cache_usage WHERE name='documents'")
    .first();
  assert.equal(
    usage.bytes,
    (
      await raw
        .prepare(
          'SELECT SUM(length(CAST(payload AS BLOB))) AS bytes FROM search_documents',
        )
        .first()
    ).bytes,
  );
  const before = reads;
  const cached = await completeSearch(db, 'teshuva', {}, 1, first.run);
  assert.equal(reads, before);
  cached.items[0].title = 'Local mutation';
  assert.notEqual(
    (await completeSearch(db, 'teshuva', {}, 1, first.run)).items[0].title,
    'Local mutation',
  );
});

void test('a timed-out candidate page recovers without losing filters, candidates, or the scan cursor', async (t) => {
  const { completeSearch: resilientSearch } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64') +
      '#interrupted-page'
  );
  const requests = [];
  let interrupted = false;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    requests.push(url.href);
    assert.equal(url.searchParams.get('teacherID'), '1');
    const page = Number(url.searchParams.get('start'));
    if (page === 4 && !interrupted) {
      interrupted = true;
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    return Response.json({
      response: {
        docs: records.slice((page - 1) * 30, page * 30),
        numFound: records.length,
      },
    });
  });
  const db = database();
  const filters = { teacherId: 1, max: 30 };
  const first = await resilientSearch(db, 'teshuva', filters);
  assert.equal(first.complete, false);
  assert.equal(first.scanned, 120);
  const result = await resilientSearch(db, 'teshuva', filters, 1, first.run);
  assert.equal(result.run, first.run);
  assert.equal(result.complete, true);
  assert.equal(result.scanned, 181);
  assert.equal(result.sourceTotal, 181);
  assert.equal(result.total, 30);
  assert.equal(new Set(result.items.map((s) => s.id)).size, 30);
  assert.ok(result.items.every((s) => s.teacherId === 1 && s.duration <= 1800));
  assert.equal(result.related, false);
  const retries = requests.filter(
    (url) => new URL(url).searchParams.get('start') === '4',
  );
  assert.equal(retries.length, 2);
  assert.equal(retries[0], retries[1]);
});

void test('exhausted page reads preserve a verified prefix and resume the gap for strict and fallback searches', async (t) => {
  for (const interruption of ['timeout', 'http'])
    for (const fallback of [false, true]) {
      await t.test(
        interruption + (fallback ? ' fallback' : ' strict'),
        async (t) => {
          const { completeSearch: search } = await import(
            'data:text/javascript;base64,' +
              Buffer.from(compiled.outputFiles[0].text).toString('base64') +
              '#prefix-' +
              interruption +
              fallback
          );
          let failures = 3;
          const requests = [];
          t.mock.method(globalThis, 'fetch', async (input) => {
            const url = new URL(input);
            if (url.pathname.includes('/browse/')) return Response.json([]);
            assert.equal(url.searchParams.get('teacherID'), '1');
            if (
              fallback &&
              url.searchParams.get('searchTerm').includes('zzzxqv')
            )
              return Response.json({ response: { numFound: 0, docs: [] } });
            requests.push(url.href);
            const page = Number(url.searchParams.get('start'));
            if (page === 2 && failures-- > 0) {
              if (interruption === 'timeout')
                throw new DOMException('Timed out.', 'TimeoutError');
              return new Response('Temporary server failure', { status: 500 });
            }
            return Response.json({
              response: {
                docs: records.slice((page - 1) * 30, page * 30),
                numFound: records.length,
              },
            });
          });
          const db = database();
          const query = fallback ? 'tefillah shabbat zzzxqv' : 'teshuva';
          const filters = { teacherId: 1, max: 30, sort: 'library' };
          const first = await search(db, query, filters);
          assert.equal(first.scanned, 30);
          assert.equal(first.sourceTotal, 181);
          assert.equal(first.complete, false);
          assert.equal(first.related, fallback);
          const saved = await db
            .prepare('SELECT * FROM search_runs WHERE id = ?')
            .bind(first.run)
            .first();
          assert.equal(saved.next, 2);
          assert.equal(saved.lease, 0);
          let result = first;
          for (let pass = 0; !result.complete && pass < 3; pass++)
            result = await search(db, query, filters, 1, first.run);
          assert.equal(result.run, first.run);
          assert.equal(result.complete, true);
          assert.equal(result.scanned, 181);
          assert.equal(result.total, 30);
          assert.ok(
            result.items.every((s) => s.teacherId === 1 && s.duration <= 1800),
          );
          assert.equal(new Set(result.items.map((s) => s.id)).size, 30);
          const gap = requests.filter(
            (url) => new URL(url).searchParams.get('start') === '2',
          );
          assert.equal(gap.length, 4);
          assert.equal(new Set(gap).size, 1);
          assert.equal(
            requests.filter(
              (url) => new URL(url).searchParams.get('start') === '1',
            ).length,
            1,
          );
        },
      );
    }
});

void test('repeated timeouts without progress stop after three passes and keep the run retryable', async (t) => {
  const { completeSearch: search } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64') +
      '#stalled-passes'
  );
  let stalled = true;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    const page = Number(url.searchParams.get('start'));
    if (page === 5 && stalled)
      throw new DOMException('Timed out.', 'TimeoutError');
    return Response.json({
      response: {
        docs: records.slice((page - 1) * 30, page * 30),
        numFound: records.length,
      },
    });
  });
  const db = database();
  const first = await search(db, 'teshuva', {});
  for (let pass = 0; pass < 2; pass++) {
    const result = await search(db, 'teshuva', {}, 1, first.run);
    assert.equal(result.complete, false);
    assert.equal(result.scanned, 120);
  }
  await assert.rejects(search(db, 'teshuva', {}, 1, first.run));
  const saved = await db
    .prepare('SELECT * FROM search_runs WHERE id = ?')
    .bind(first.run)
    .first();
  assert.equal(saved.next, 5);
  assert.equal(saved.lease, 0);
  stalled = false;
  const result = await search(db, 'teshuva', {}, 1, first.run);
  assert.equal(result.run, first.run);
  assert.equal(result.complete, true);
  assert.equal(result.scanned, 181);
});

void test('an interrupted page cannot hide invalid responses elsewhere in the same pass', async (t) => {
  for (const kind of ['changed', 'incomplete', 'http']) {
    await t.test(kind, async (t) => {
      const { completeSearch: search } = await import(
        'data:text/javascript;base64,' +
          Buffer.from(compiled.outputFiles[0].text).toString('base64') +
          '#invalid-after-gap-' +
          kind
      );
      t.mock.method(globalThis, 'fetch', async (input) => {
        const url = new URL(input);
        if (url.pathname.includes('/browse/')) return Response.json([]);
        const page = Number(url.searchParams.get('start'));
        if (page === 2) throw new DOMException('Timed out.', 'TimeoutError');
        if (page === 4 && kind === 'http')
          return new Response('Invalid request', { status: 400 });
        return Response.json({
          response: {
            docs:
              page === 4 && kind === 'incomplete'
                ? []
                : records.slice((page - 1) * 30, page * 30),
            numFound:
              records.length + (page === 4 && kind === 'changed' ? 1 : 0),
          },
        });
      });
      const db = database();
      await assert.rejects(
        search(db, 'teshuva', {}),
        kind === 'changed'
          ? /library changed/
          : kind === 'incomplete'
            ? /incomplete search page/
            : /returned 400/,
      );
      const saved = await db
        .prepare('SELECT * FROM search_runs LIMIT 1')
        .first();
      if (kind === 'changed') assert.equal(saved, null);
      else {
        assert.equal(saved.next, 1);
        assert.equal(saved.lease, 0);
        assert.equal(
          (await db.prepare('SELECT COUNT(*) AS n FROM search_hits').first()).n,
          0,
        );
      }
    });
  }
});

void test('valid chapter names and exact archive spellings reach the source without a typo rewrite', async (t) => {
  for (const [query, title, unwanted] of [
    ['perek kirah', 'Shabbos Perek Kirah', 'kinah'],
    ['pryaer', 'A Lesson Named Pryaer', 'tefillah'],
  ]) {
    const db = database();
    await db.batch(indexFixtureTitles(db, [{ id: 9001, title }]));
    t.mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(input);
      if (url.pathname.includes('/browse/')) return Response.json([]);
      const sourceQuery = url.searchParams.get('searchTerm');
      assert.ok(sourceQuery.includes(query.split(' ').at(-1)), sourceQuery);
      assert.ok(!sourceQuery.includes(unwanted), sourceQuery);
      assert.equal(url.searchParams.get('teacherID'), '1');
      return Response.json({
        response: {
          numFound: 1,
          docs: [{ ...records[0], shiurtitle: title, duration: 10 }],
        },
      });
    });
    const result = await completeSearch(db, query, {
      teacherId: 1,
      max: 30,
      scope: 'title',
    });
    assert.equal(result.plan.term, query);
    assert.equal(result.plan.original, query);
    assert.equal(result.total, 1);
    assert.equal(result.correction, undefined);
    assert.equal(result.suggestion, undefined);
    t.mock.restoreAll();
  }
});

void test('choosing the original spelling bypasses all expansion and keeps a separate filtered run', async (t) => {
  const db = database();
  const queries = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    const query = url.searchParams.get('searchTerm');
    queries.push(query);
    assert.equal(url.searchParams.get('teacherID'), '1');
    assert.equal(url.searchParams.get('seriesID'), '20');
    assert.equal(url.searchParams.get('subcategoryID'), '10');
    const docs = [
      {
        ...records[0],
        shiurtitle: 'The Meaning of Tefillah',
        duration: 10,
      },
    ];
    return Response.json({ response: { docs, numFound: docs.length } });
  });
  const filters = {
    teacherId: 1,
    seriesId: 20,
    topicId: 10,
    max: 30,
    language: 'EN',
    format: 'audio',
    scope: 'title',
  };
  const corrected = await completeSearch(db, 'pryaer', filters);
  assert.equal(corrected.correction, 'tefillah');
  assert.equal(corrected.plan.original, 'pryaer');
  assert.equal(corrected.total, 1);
  const original = await completeSearch(db, 'pryaer', {
    ...filters,
    literal: true,
  });
  assert.equal(queries.at(-1), 'pryaer');
  assert.equal(original.total, 0);
  assert.equal(original.plan.literal, true);
  assert.equal(original.plan.term, 'pryaer');
  assert.equal(original.plan.teacherId, 1);
  assert.equal(original.plan.seriesId, 20);
  assert.equal(original.plan.topicId, 10);
  assert.equal(original.plan.max, 30);
  assert.equal(original.plan.language, 'EN');
  assert.equal(original.plan.format, 'audio');
  assert.equal(original.correction, undefined);
  assert.equal(original.suggestion, undefined);
  assert.notEqual(original.run, corrected.run);
});

void test('learning a formerly unknown spelling does not change an in-progress correction', async (t) => {
  const db = database();
  const queries = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    queries.push(url.searchParams.get('searchTerm'));
    const page = Number(url.searchParams.get('start'));
    return Response.json({
      response: {
        numFound: records.length,
        docs: records
          .slice((page - 1) * 30, page * 30)
          .map((raw) => ({ ...raw, shiurtitle: 'Tefillah' })),
      },
    });
  });
  const first = await completeSearch(db, 'pryaer', {});
  assert.equal(first.complete, false);
  assert.equal(first.correction, 'tefillah');
  await db.batch(indexFixtureTitles(db, [{ id: 9001, title: 'Pryaer' }]));
  const resumed = await completeSearch(db, 'pryaer', {}, 1, first.run);
  assert.equal(resumed.run, first.run);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.plan.term, 'tefillah');
  assert.equal(resumed.total, records.length);
  assert.ok(queries.every((query) => query.includes('tefillah')));
});

void test('a zero-result indexed spelling offers a verified alternative without changing the query or filters', async () => {
  const { completeSearch: recoveredSearch } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64') +
      '#indexed-spelling'
  );
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
  const fixtureFetch = globalThis.fetch;
  const queries = [];
  let exact = false;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    const query = url.searchParams.get('searchTerm');
    queries.push(query);
    assert.equal(url.searchParams.get('teacherID'), '1');
    const docs =
      exact || query.includes('teshuva')
        ? [
            {
              ...records[0],
              shiurid: 9003,
              shiurtitle: exact ? 'BaSukkos Teshvu' : 'Hilchos Teshuva',
              duration: 10,
            },
          ]
        : [];
    return Response.json({ response: { numFound: docs.length, docs } });
  };
  try {
    const seeded = async () => {
      const db = database();
      await db.batch(
        indexTitleStatements(db, [
          { id: 9001, title: 'BaSukkos Teshvu' },
          { id: 9002, title: 'Hilchos Teshuva' },
        ]),
      );
      return db;
    };
    const seededDb = await seeded();
    const result = await recoveredSearch(seededDb, 'teshvu', {
      teacherId: 1,
      max: 30,
    });
    assert.doesNotMatch(queries[0], /teshuva/);
    assert.match(queries[1], /teshuva/);
    assert.equal(result.total, 0);
    assert.equal(result.complete, true);
    assert.equal(result.items.length, 0);
    assert.equal(result.plan.term, 'teshvu');
    assert.equal(result.plan.teacherId, 1);
    assert.equal(result.plan.max, 30);
    assert.equal(result.related, false);
    assert.equal(result.suggestion, 'teshuva');
    const callsBeforeResume = queries.length;
    const resumed = await recoveredSearch(
      seededDb,
      'teshvu',
      { teacherId: 1, max: 30 },
      1,
      result.run,
    );
    assert.equal(resumed.suggestion, 'teshuva');
    assert.equal(resumed.run, result.run);
    assert.equal(
      queries.length,
      callsBeforeResume,
      'The suggestion is snapshotted with the run',
    );
    const selected = await recoveredSearch(seededDb, result.suggestion, {
      teacherId: 1,
      max: 30,
    });
    assert.equal(selected.total, 1);
    assert.equal(selected.plan.teacherId, 1);
    assert.equal(selected.plan.max, 30);
    const calls = queries.length;
    await recoveredSearch(await seeded(), '"teshvu"', {
      teacherId: 1,
      max: 30,
    });
    assert.equal(
      queries.length,
      calls + 1,
      'Quotes cannot activate spelling recovery',
    );
    exact = true;
    const strict = await recoveredSearch(await seeded(), 'teshvu', {
      teacherId: 1,
      max: 30,
    });
    assert.equal(strict.total, 1);
    assert.doesNotMatch(queries.at(-1), /teshuva/);
    assert.equal(strict.suggestion, undefined);
    exact = false;
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname.includes('/browse/')) return Response.json([]);
      if (url.searchParams.get('searchTerm').includes('teshuva'))
        throw new DOMException('The operation timed out.', 'TimeoutError');
      return Response.json({ response: { numFound: 0, docs: [] } });
    };
    const unavailableSuggestion = await recoveredSearch(
      await seeded(),
      'teshvu',
      { teacherId: 1, max: 30 },
    );
    assert.equal(unavailableSuggestion.total, 0);
    assert.equal(unavailableSuggestion.complete, true);
    assert.equal(unavailableSuggestion.suggestion, undefined);
  } finally {
    globalThis.fetch = fixtureFetch;
  }
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

void test('teacher profile popularity includes the most viewed shiur beyond the first indexing pass', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    assert.equal(url.searchParams.get('teacherID'), '1');
    assert.equal(url.searchParams.get('searchTerm'), '*');
    const page = Number(url.searchParams.get('start'));
    return Response.json({
      response: {
        docs: records.slice((page - 1) * 30, page * 30),
        numFound: records.length,
      },
    });
  });
  const db = database();
  const options = { teacherId: 1, sort: 'popular' };
  let result = await completeSearch(db, '', options);
  assert.equal(result.complete, false);
  assert.notEqual(result.items[0].id, 180);
  while (!result.complete)
    result = await completeSearch(db, '', options, 1, result.run);
  assert.equal(result.scanned, records.length);
  assert.equal(result.items[0].id, 180);
  assert.equal(result.items[0].views, 1000000);
  assert.deepEqual(
    result.items.map((s) => s.views),
    result.items.map((s) => s.views).sort((a, b) => b - a),
  );
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
    assert.equal(queries.length, 3);
    assert.equal(
      new Set(queries).size,
      1,
      'Server retries must not broaden the query',
    );
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
