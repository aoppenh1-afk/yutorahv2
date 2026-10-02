import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [
    'lib/title-index.ts',
    'lib/title-catalog.ts',
    'packages/yutorah-core/src/search-matching.ts',
    'lib/title-migration.ts',
    'lib/title-transfer.ts',
    'scripts/migrate-search-schema.ts',
  ],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  outdir: 'unused',
});
const [index, catalog, matching, migration, transfer, schema] =
  await Promise.all(
    compiled.outputFiles.map(
      (file) =>
        import(
          'data:text/javascript;base64,' +
            Buffer.from(file.text).toString('base64')
        ),
    ),
  );

void test('title evidence recovers a transposition plus missing letter in Shmini aztret', async () => {
  const db = database();
  await db.batch(
    index.indexTitleStatements(db, [
      { id: 1, title: 'Understanding Shemini Atzeret' },
      { id: 2, title: 'Shmini Atzeret: Bringing It All Together' },
    ]),
  );
  const learned = await index.titleVocabulary(db, 'Shmini aztret');
  assert.ok(learned.words.includes('atzeret'));
  const retrieval = matching.searchRetrieval('Shmini aztret', learned.words);
  assert.match(retrieval.strictQuery, /atzeret/);
  assert.equal(retrieval.matches('Shmini Atzeret'), true);
  assert.equal(retrieval.matches('Shemini Atzeret'), true);
  assert.equal(retrieval.matches('Shemini: the eighth day'), false);
  assert.equal(matching.wordMatch('eruv', 'erev'), 0);
  assert.equal(matching.wordMatch('123', '124'), 0);
  assert.equal(matching.wordMatch('cat', 'charity'), 0);
});

void test('Vercel schema setup survives partial application and preserves indexed titles on redeployment', async () => {
  const db = database();
  await db.batch(
    index.indexTitleStatements(db, [{ id: 42, title: 'Quantum Halacha' }]),
  );
  const before = (
    await db.prepare('SELECT * FROM search_title_terms ORDER BY term').all()
  ).results;
  await db.prepare('DROP TABLE search_title_imports').run();
  await db.prepare('DROP TABLE search_title_cursors').run();
  await migrate();
  await migrate();
  assert.deepEqual(
    (await db.prepare('SELECT * FROM search_title_terms ORDER BY term').all())
      .results,
    before,
  );
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) AS count FROM search_title_catalog')
        .first()
    ).count,
    1,
  );

  async function migrate() {
    await schema.migrateTitleSchema(db);
  }
});

void test('an indexed spelling keeps exact retrieval first and can recover a close spelling after zero results', async () => {
  const db = database();
  await db.batch(
    index.indexTitleStatements(db, [
      { id: 1, title: 'BaSukkos Teshvu' },
      { id: 2, title: 'Hilchos Teshuva' },
    ]),
  );
  const learned = await index.titleVocabulary(db, 'teshvu');
  const retrieval = matching.searchRetrieval('teshvu', learned.words);
  assert.doesNotMatch(retrieval.strictQuery, /teshuva/);
  assert.match(retrieval.spellingQuery, /teshuva/);
  assert.equal(
    matching.searchRetrieval('eruv', ['eruv', 'erev']).spellingQuery,
    '',
  );
  assert.equal(
    matching.searchRetrieval('900', ['900', '901']).spellingQuery,
    '',
  );
  assert.equal(
    matching.searchRetrieval('crispix', ['crispix']).spellingQuery,
    '',
  );
});

void test('production transfer resumes committed batches and audits titles and spelling keys', async () => {
  const source = database();
  const target = database();
  const records = [
    { id: 900, title: 'New Recognition Vocabulary' },
    { id: 903, title: 'Vocabulary Spelling' },
  ];
  await source.batch(index.indexTitleStatements(source, records));
  const entries = (
    await source
      .prepare('SELECT key,term FROM search_title_keys ORDER BY key,term')
      .all()
  ).results.map((row) => [row.key, row.term]);
  const manifest = {
    operation: 'start',
    minimum: 900,
    maximum: 903,
    total: 2,
    keys: entries.length,
  };
  await target
    .prepare(
      "INSERT INTO search_runs (id,fingerprint,plan,total,created) VALUES ('empty','empty','{}',0,1),('pending','pending','{}',300,1)",
    )
    .run();
  await transfer.transferTitles(target, manifest);
  await assert.rejects(
    transfer.transferTitles(target, { operation: 'finish' }),
    /incomplete/,
  );
  await assert.rejects(
    transfer.transferTitles(target, {
      operation: 'titles',
      next: 900,
      records: [records[1], records[0]],
    }),
    /Invalid title/,
  );
  const body = { operation: 'titles', next: 900, records };
  await transfer.transferTitles(target, body);
  const retry = await transfer.transferTitles(target, body);
  assert.equal(retry.titles.scanned, 2);
  assert.equal(retry.titles.next, 904);
  assert.equal(
    (
      await target
        .prepare(
          "SELECT documents FROM search_title_terms WHERE term='vocabulary'",
        )
        .first()
    ).documents,
    2,
  );
  await assert.rejects(
    transfer.transferTitles(target, { operation: 'finish' }),
    /incomplete/,
  );
  const keys = { operation: 'keys', next: 0, entries };
  await transfer.transferTitles(target, keys);
  await transfer.transferTitles(target, keys);
  const completed = await transfer.transferTitles(target, {
    operation: 'finish',
  });
  assert.ok(completed.titles.completed);
  assert.equal(completed.keys.next, entries.length);
  assert.equal(
    await target.prepare("SELECT id FROM search_runs WHERE id='empty'").first(),
    null,
  );
  assert.ok(
    await target
      .prepare("SELECT id FROM search_runs WHERE id='pending'")
      .first(),
  );
  assert.deepEqual(
    await index.titleVocabulary(target, 'vocabulray'),
    await index.titleVocabulary(source, 'vocabulray'),
  );
  await assert.rejects(
    transfer.transferTitles(target, { ...manifest, total: 3 }),
    /different archive/,
  );
});

void test('production transfer rejects unauthenticated requests and disables itself without a secret', async () => {
  const request = (authorization) =>
    new Request('https://example.test/api/search-index', {
      headers: authorization ? { Authorization: authorization } : {},
    });
  assert.equal(await transfer.transferAuthorized(request()), false);
  assert.equal(
    await transfer.transferAuthorized(
      request('Bearer secret'),
      undefined,
      true,
    ),
    false,
  );
  assert.equal(
    await transfer.transferAuthorized(request(), 'secret', true),
    false,
  );
  assert.equal(
    await transfer.transferAuthorized(request('Bearer wrong'), 'secret', true),
    false,
  );
  assert.equal(
    await transfer.transferAuthorized(request('Bearer secret'), 'secret', true),
    true,
  );
  assert.equal(
    await transfer.transferAuthorized(request('Bearer secret'), 'secret'),
    false,
  );
  assert.equal(
    await transfer.transferAuthorized(
      request('Bearer secret'),
      'secret',
      false,
    ),
    false,
  );
});

void test('full migration uses a fixed ID snapshot and resumes only after committed ranges', async () => {
  const db = database();
  const titles = Array.from({ length: 61 }, (_, i) => ({
    shiurid: 900 + i,
    shiurtitle: `Archive Vocabulary ${i}`,
  }));
  let fail = 0;
  const read = async (minimum, maximum, descending = false) => {
    if (minimum === fail) {
      fail = 0;
      throw new Error('Timeout');
    }
    const records = titles.filter(
      (record) =>
        minimum === undefined ||
        (record.shiurid >= minimum && record.shiurid <= maximum),
    );
    return {
      numFound: records.length,
      docs: (descending ? [...records].reverse() : records).slice(0, 30),
    };
  };
  const first = await migration.migrateTitleArchive(db, 1, 4, read);
  assert.equal(first.next, 930);
  assert.equal(first.scanned, 30);
  assert.equal(first.maximum, 960);
  titles.push({ shiurid: 961, shiurtitle: 'A New Upload' });
  fail = 930;
  await assert.rejects(
    migration.migrateTitleArchive(db, 3, 4, read),
    /Timeout/,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT next FROM search_title_imports WHERE name='archive'")
        .first()
    ).next,
    930,
  );
  const resumed = await migration.migrateTitleArchive(db, 3, 4, read);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.total, 61);
  assert.equal(resumed.scanned, 61);
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) AS titles FROM search_title_catalog')
        .first()
    ).titles,
    61,
  );
  assert.equal(
    await db
      .prepare('SELECT id FROM search_title_catalog WHERE id=961')
      .first(),
    null,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT documents FROM search_title_terms WHERE term='vocabulary'",
        )
        .first()
    ).documents,
    61,
  );
  const completed = await migration.migrateTitleArchive(db, 1, 4, async () => {
    throw new Error('Completed snapshots must not restart');
  });
  assert.equal(completed.complete, true);
});

void test('migration rejects missing, duplicate, and out-of-range titles without advancing its checkpoint', async () => {
  for (const corrupt of ['missing', 'duplicate', 'outside']) {
    const db = database();
    const title = (id) => ({ shiurid: id, shiurtitle: 'Vocabulary' });
    const read = async (minimum, maximum, descending = false) => {
      if (minimum === undefined)
        return { numFound: 61, docs: [title(descending ? 960 : 900)] };
      if (maximum === 960) return { numFound: 61, docs: [title(900)] };
      return corrupt === 'missing'
        ? { numFound: 2, docs: [title(900)] }
        : corrupt === 'duplicate'
          ? { numFound: 2, docs: [title(900), title(900)] }
          : { numFound: 1, docs: [title(960)] };
    };
    await assert.rejects(
      migration.migrateTitleArchive(db, 1, 1, read),
      /invalid title range/,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT next FROM search_title_imports WHERE name='archive'")
          .first()
      ).next,
      900,
    );
    assert.equal(
      (
        await db
          .prepare('SELECT COUNT(*) AS titles FROM search_title_catalog')
          .first()
      ).titles,
      0,
    );
  }
});

void test('reaching the final ID cannot complete a migration whose coverage audit fails', async () => {
  const db = database();
  const titles = Array.from({ length: 31 }, (_, i) => ({
    shiurid: 900 + i,
    shiurtitle: 'Vocabulary',
  }));
  let snapshotReads = 0;
  let failAudit = true;
  const read = async (minimum, maximum, descending = false) => {
    const records = titles.filter(
      (record) =>
        minimum === undefined ||
        (record.shiurid >= minimum && record.shiurid <= maximum),
    );
    const audit = minimum === 900 && maximum === 930 && ++snapshotReads > 1;
    return {
      numFound: records.length + (audit && failAudit ? 1 : 0),
      docs: (descending ? [...records].reverse() : records).slice(0, 30),
    };
  };
  await assert.rejects(
    migration.migrateTitleArchive(db, 2, 2, read),
    /coverage audit failed/,
  );
  const run = await db
    .prepare(
      "SELECT next,completed FROM search_title_imports WHERE name='archive'",
    )
    .first();
  assert.equal(run.next, 931);
  assert.equal(run.completed, 0);
  failAudit = false;
  assert.equal(
    (await migration.migrateTitleArchive(db, 2, 2, read)).complete,
    true,
  );
});
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync('drizzle')
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  const prepare = (sql, params = []) => ({
    bind: (...values) => prepare(sql, values),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => ({
      meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) },
    }),
  });
  const db = {
    prepare,
    batch: async (statements) => {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return db;
}

void test('unmapped archive vocabulary finds typos and word boundaries without new aliases', async () => {
  const db = database();
  await db.batch(
    index.indexTitleStatements(db, [
      { id: 1, title: 'The Beracha on Crispix' },
      { id: 2, title: 'Returning to Shul After Quarantine' },
      { id: 3, title: 'Safek Berachos and Medical Ethics' },
      { id: 4, title: 'עיקול נכסים בבית הדין' },
    ]),
  );
  for (const [query, word] of [
    ['qurantin', 'quarantine'],
    ['crispx', 'crispix'],
    ['עיקלו', 'עיקול'],
  ]) {
    const learned = await index.titleVocabulary(db, query);
    assert.ok(learned.words.includes(word), `${query}: ${learned.words}`);
    assert.ok(matching.librarySearchQuery(query, learned.words).includes(word));
  }
  for (const [query, expected] of [
    ['safekberachos', 'safek berachos'],
    ['cris pix', 'crispix'],
    ['medicalethics', 'medical ethics'],
  ]) {
    const learned = await index.titleVocabulary(db, query);
    assert.equal(
      matching.interpretSpacing(query, learned.phrases).term,
      expected,
    );
  }
  assert.deepEqual(await index.titleVocabulary(db, '"crispx" 613'), {
    words: [],
    phrases: [],
  });
});

void test('frequency counts unique titles, follows title edits, and does not rewrite ambiguous boundaries', async () => {
  const db = database();
  const titles = [
    { id: 1, title: 'Cat and Cot' },
    { id: 2, title: 'Cot' },
    { id: 3, title: 'Cot' },
  ];
  await db.batch(index.indexTitleStatements(db, titles));
  await db.batch(index.indexTitleStatements(db, titles));
  assert.equal(
    (
      await db
        .prepare("SELECT documents FROM search_title_terms WHERE term='cot'")
        .first()
    ).documents,
    3,
  );
  const candidates = await index.titleVocabulary(db, 'ct');
  assert.equal(
    candidates.words.length,
    0,
    'Short input is not fuzzy corrected',
  );
  await db.batch(index.indexTitleStatements(db, [{ id: 3, title: 'Cat' }]));
  assert.equal(
    (
      await db
        .prepare("SELECT documents FROM search_title_terms WHERE term='cot'")
        .first()
    ).documents,
    2,
  );
  await db.batch(
    index.indexTitleStatements(db, [
      { id: 4, title: 'Therapist' },
      { id: 5, title: 'The Rapist' },
    ]),
  );
  const ambiguous = await index.titleVocabulary(db, 'therapist');
  assert.equal(
    matching.interpretSpacing('therapist', ambiguous.phrases).term,
    'therapist',
  );
  await db.prepare('DELETE FROM search_title_catalog WHERE id=3').run();
  assert.equal(
    (
      await db
        .prepare("SELECT documents FROM search_title_terms WHERE term='cat'")
        .first()
    ).documents,
    1,
  );
});

void test('whole-word matches stay ahead of spelling candidates and frequency breaks equal-distance ties', async () => {
  const db = database();
  await db.batch(
    index.indexTitleStatements(db, [
      { id: 1, title: 'Complaint and Compliant' },
      { id: 2, title: 'Compliant' },
      { id: 3, title: 'Compliant' },
      { id: 4, title: 'Complient' },
    ]),
  );
  const typo = await index.titleVocabulary(db, 'complint');
  assert.ok(typo.words.includes('complaint'));
  assert.ok(typo.words.includes('compliant'));
  assert.ok(typo.words.indexOf('compliant') < typo.words.indexOf('complaint'));
  const literal = await index.titleVocabulary(db, 'complaint');
  assert.equal(literal.words[0], 'complaint');
  assert.doesNotMatch(
    matching.librarySearchQuery('complaint', literal.words),
    /compliant|complaint~/,
  );
});

void test('archive backfill resumes atomically and refreshes new titles without duplicating word counts', async () => {
  const db = database();
  const realFetch = globalThis.fetch;
  let fail = 0;
  const pages = [];
  const titles = Array.from({ length: 61 }, (_, i) => ({
    shiurid: i + 1,
    shiurtitle: `Unmapped Vocabulary ${i}`,
  }));
  globalThis.fetch = async (input) => {
    const page = Number(new URL(input).searchParams.get('start'));
    pages.push(page);
    if (page === fail) {
      fail = 0;
      return new Response('Unavailable', { status: 503 });
    }
    return Response.json({
      response: {
        docs: titles.slice((page - 1) * 30, page * 30),
        numFound: titles.length,
      },
    });
  };
  try {
    const first = await catalog.refreshTitleCatalog(db, 1);
    assert.equal(first.nextPage, 2);
    assert.equal(first.titles, 30);
    fail = 2;
    await assert.rejects(catalog.refreshTitleCatalog(db, 2));
    assert.equal(
      (
        await db
          .prepare("SELECT next FROM search_title_cursors WHERE name='archive'")
          .first()
      ).next,
      2,
    );
    const resumed = await catalog.refreshTitleCatalog(db, 2);
    assert.equal(resumed.complete, true);
    assert.equal(resumed.titles, 61);
    assert.deepEqual(pages, [1, 1, 2, 1, 2, 3]);
    assert.equal(
      (
        await db
          .prepare(
            "SELECT documents FROM search_title_terms WHERE term='vocabulary'",
          )
          .first()
      ).documents,
      61,
    );
    await db
      .prepare(
        "INSERT INTO search_runs (id,fingerprint,plan,total,created) VALUES ('cache','cache','{}',1,0)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO search_hits (run,id,payload,matched,rank,date,duration,title,position) VALUES ('cache',90,?,1,0,0,0,'',0)",
      )
      .bind(JSON.stringify({ title: 'Newcomer Vocabulary' }))
      .run();
    assert.equal(await index.seedCachedTitles(db), 1);
    await db.prepare("DELETE FROM search_runs WHERE id='cache'").run();
    assert.ok(
      (await index.titleVocabulary(db, 'newcomr')).words.includes('newcomer'),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
