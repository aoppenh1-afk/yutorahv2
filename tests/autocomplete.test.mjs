import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';

async function load(path, options = {}) {
  const compiled = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    ...options,
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64')
  );
}
const {
  findShiurSuggestions,
  createShiurAutocomplete,
  titleAutocompleteQuery,
} = await load('lib/shiur-autocomplete.ts');
const { indexTitleStatements } = await load('lib/title-index.ts');
const { combineSearchSuggestions, suggestSearch } = await load(
  'lib/search-discovery.ts',
);
const { postgresSearchSql } = await load('lib/search-postgres.ts', {
  plugins: [
    {
      name: 'pg-path',
      setup(build) {
        build.onResolve({ filter: /^pg$/ }, () => ({
          path: import.meta.resolve('pg'),
          external: true,
        }));
      },
    },
  ],
});

function database(beforeAutocomplete = []) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const queries = [];
  for (const file of readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (file.startsWith('0004'))
      for (const { id, title } of beforeAutocomplete)
        sqlite
          .prepare(
            'INSERT INTO search_title_catalog(id,title,terms) VALUES(?,?,?)',
          )
          .run(id, title, '[]');
    sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  }
  const prepare = (sql, params = []) => ({
    bind: (...values) => prepare(sql, values),
    first: async () => {
      queries.push(sql);
      return sqlite.prepare(sql).get(...params) ?? null;
    },
    all: async () => {
      queries.push(sql);
      return { results: sqlite.prepare(sql).all(...params) };
    },
    run: async () => ({
      meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) },
    }),
  });
  const db = {
    prepare,
    batch: async (statements) => {
      sqlite.exec('BEGIN');
      try {
        const result = await Promise.all(statements.map((s) => s.run()));
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, sqlite, queries };
}

async function seed(db) {
  await db.batch(
    indexTitleStatements(db, [
      { id: 1, title: 'Coffee Shabbos' },
      { id: 2, title: 'Making Coffee on Shabbos' },
      { id: 3, title: 'Coffee on Shabbat' },
      { id: 4, title: 'Coffee on Shabbos: A Practical Guide' },
      { id: 5, title: 'Hilchos Shabbos: Making Coffee' },
      { id: 6, title: 'Coffee, Tea and Many Other Questions on Shabbat' },
      { id: 7, title: 'Tea on Shabbos' },
      { id: 8, title: 'Coffee on Yom Tov' },
      { id: 9, title: 'Sukkas: The Mitzvah' },
      { id: 10, title: 'Quantum Halacha' },
      { id: 11, title: 'שבת וקפה' },
      { id: 12, title: 'Shabbos 123' },
      { id: 13, title: 'Shabbos 1234' },
    ]),
  );
}

void test('main search offers collections by title', () => {
  const directory = {
    teachers: [],
    topics: [],
    series: [],
    groups: [],
    collections: [{ id: 80, name: 'The Weekly Parsha', count: 20 }],
  };
  const items = combineSearchSuggestions(
    suggestSearch('The Weekly Parsha', directory),
    [],
    'The Weekly Parsha',
  );
  assert.equal(items[0]?.kind, 'collection');
  assert.equal(items[0]?.id, 80);
});

void test('main search ranks series and shiurim by title accuracy in either direction', () => {
  const series = (id, name) => ({
    id,
    kind: 'series',
    name,
    count: 1000,
    context: 'Series',
  });
  const shiur = (id, name) => ({ id, kind: 'shiur', name, context: 'Shiur' });
  assert.equal(
    combineSearchSuggestions(
      [series(20, 'Coffee Shabbos: A Practical Guide')],
      [shiur(1, 'Coffee Shabbos')],
      'Coffee Shabbos',
    )[0].kind,
    'shiur',
  );
  assert.equal(
    combineSearchSuggestions(
      [series(20, 'Coffee Shabbos')],
      [shiur(1, 'Coffee Shabbos: A Practical Guide')],
      'Coffee Shabbos',
    )[0].kind,
    'series',
  );
});

void test('main search does not reserve result slots by content type', () => {
  const series = Array.from({ length: 8 }, (_, i) => ({
    id: 20 + i,
    kind: 'series',
    name: 'Coffee Shabbos',
    count: i,
    context: 'Series',
  }));
  const shiurim = [
    {
      id: 1,
      kind: 'shiur',
      name: 'Coffee Shabbos: A Practical Guide',
      context: 'Shiur',
    },
  ];
  assert.equal(
    combineSearchSuggestions(series, shiurim, 'Coffee Shabbos').length,
    8,
  );
  assert.ok(
    combineSearchSuggestions(series, shiurim, 'Coffee Shabbos').every(
      (item) => item.kind === 'series',
    ),
  );
});

void test('content type and collection size do not break equal title matches, and duplicate entities are removed', () => {
  const collection = {
    id: 21,
    kind: 'collection',
    name: 'Coffee Shabbos',
    count: 100000,
    context: 'Collection',
  };
  const shiur = {
    id: 22,
    kind: 'shiur',
    name: 'Coffee Shabbos',
    context: 'Shiur',
  };
  const first = combineSearchSuggestions(
    [collection],
    [shiur, collection],
    'Coffee Shabbos',
  );
  assert.deepEqual(
    first.map((item) => item.id),
    [22, 21],
  );
  const swapped = combineSearchSuggestions(
    [{ ...collection, kind: 'shiur' }],
    [{ ...shiur, kind: 'collection', count: 1 }],
    'Coffee Shabbos',
  );
  assert.deepEqual(
    swapped.map((item) => item.id),
    [22, 21],
  );
});

void test('collection title suggestions support partial words, typos, Hebrew aliases, and literal request words', () => {
  const directory = {
    teachers: [],
    topics: [],
    series: [],
    groups: [],
    collections: [
      { id: 80, name: 'Daf Yomi', count: 1 },
      { id: 81, name: 'Hilchos Shabbos', count: 1 },
      { id: 82, name: 'Daily Shiur', count: 1 },
      { id: 83, name: 'English', count: 1 },
    ],
  };
  for (const query of ['Daf Yom', 'daf ymi', 'dafyomi'])
    assert.equal(suggestSearch(query, directory)[0]?.id, 80, query);
  assert.equal(suggestSearch('הלכות שבת', directory)[0]?.id, 81);
  assert.equal(suggestSearch('Daily Shiur', directory)[0]?.id, 82);
  assert.equal(suggestSearch('English', directory)[0]?.id, 83);
});

void test('returns complete title matches, including aliases, and excludes partial subjects', async (t) => {
  const { db, sqlite } = database();
  t.after(() => sqlite.close());
  await seed(db);
  const items = await findShiurSuggestions(db, 'coffee in shabbos');
  assert.equal(items.length, 6);
  assert.equal(items[0].id, 1);
  assert.ok(
    items.some((s) => s.id === 3),
    'Shabbat is a valid transliteration',
  );
  assert.ok(items.every((s) => s.kind === 'shiur' && ![7, 8].includes(s.id)));
  assert.equal(new Set(items.map((s) => s.id)).size, 6);
});

void test('learned title words recover incomplete and misspelled titles and keep numbers exact', async (t) => {
  const { db, sqlite } = database();
  t.after(() => sqlite.close());
  await seed(db);
  assert.ok((await findShiurSuggestions(db, 'coffe shab')).length > 0);
  assert.equal((await findShiurSuggestions(db, 'qunatum halacha'))[0].id, 10);
  assert.deepEqual(
    (await findShiurSuggestions(db, 'shabbos 123')).map((s) => s.id),
    [12],
  );
  assert.equal((await findShiurSuggestions(db, 'קפה שבת'))[0].id, 11);
});

void test('title suggestions retrieve English and Hebrew concept alternatives through the actual FTS index', async (t) => {
  const { db, sqlite } = database();
  t.after(() => sqlite.close());
  await db.batch(
    indexTitleStatements(db, [
      { id: 101, title: 'Bechira Chofshis' },
      { id: 102, title: 'Writing a Will' },
      { id: 103, title: 'חשמל בשבת' },
      { id: 104, title: 'Electricity on Yom Tov' },
    ]),
  );
  assert.equal((await findShiurSuggestions(db, 'free will'))[0].id, 101);
  assert.deepEqual(
    (await findShiurSuggestions(db, 'electricity shabbat')).map(
      (item) => item.id,
    ),
    [103],
  );
});

void test('exact topics and teacher names remain discoverable alongside shiur titles', async (t) => {
  const { db, sqlite } = database();
  t.after(() => sqlite.close());
  await seed(db);
  const directory = {
    teachers: [
      {
        id: 21,
        name: 'Rabbi Hershel Schachter',
        firstName: 'Hershel',
        lastName: 'Schachter',
        count: 100,
      },
    ],
    topics: [{ id: 22, name: 'Sukkas', count: 500, group: 'Halacha' }],
    series: [],
    groups: [],
  };
  const sukkas = combineSearchSuggestions(
    suggestSearch('Sukkas', directory),
    await findShiurSuggestions(db, 'sukkas'),
    'Sukkas',
  );
  assert.equal(sukkas[0].kind, 'topic');
  assert.equal(sukkas[0].id, 22);
  const coffee = combineSearchSuggestions(
    suggestSearch('coffee in shabbos', directory),
    await findShiurSuggestions(db, 'coffee in shabbos'),
    'coffee in shabbos',
  );
  assert.equal(coffee.length, 6);
  assert.ok(coffee.every((s) => s.kind === 'shiur'));
  assert.equal(
    combineSearchSuggestions(
      suggestSearch('Hershel Schachter', directory),
      coffee,
      'Hershel Schachter',
    )[0].kind,
    'teacher',
  );
  const many = Array.from({ length: 8 }, (_, id) => ({
    id,
    name: 'Category',
    kind: 'topic',
    context: '',
    count: 1,
  }));
  assert.equal(combineSearchSuggestions(many, coffee, 'Category').length, 8);
});

void test('the Sukkas spelling prefers the holiday category over a similar Sukkah name', () => {
  const directory = {
    teachers: [],
    series: [],
    groups: [],
    topics: [
      { id: 1, name: 'Sukkah', group: 'Talmud', count: 10000 },
      { id: 2, name: 'Sukkot', group: 'Holidays', count: 1000 },
    ],
  };
  assert.equal(suggestSearch('Sukkas', directory)[0].id, 2);
});

void test('migration backfills existing titles and triggers track inserts, title edits, and deletions', async (t) => {
  const { db, sqlite } = database([
    { id: 30, title: 'Archive Coffee Shabbos' },
  ]);
  t.after(() => sqlite.close());
  assert.equal((await findShiurSuggestions(db, 'coffee shabbos'))[0].id, 30);
  await db.batch(
    indexTitleStatements(db, [{ id: 31, title: 'New Coffee Shabbos' }]),
  );
  assert.equal((await findShiurSuggestions(db, 'coffee shabbos')).length, 2);
  await db.batch(
    indexTitleStatements(db, [{ id: 31, title: 'Different Pesach Title' }]),
  );
  assert.equal((await findShiurSuggestions(db, 'coffee shabbos')).length, 1);
  sqlite.prepare('DELETE FROM search_title_catalog WHERE id=?').run(30);
  assert.deepEqual(await findShiurSuggestions(db, 'coffee shabbos'), []);
});

void test('cache shares concurrent requests, expires, bounds entries, and isolates databases', async (t) => {
  const { db, sqlite, queries } = database();
  t.after(() => sqlite.close());
  await seed(db);
  let now = 1000;
  const suggest = createShiurAutocomplete(() => now);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => suggest(db, 'coffee shabbos')),
  );
  assert.equal(queries.length, 2);
  assert.deepEqual(results[0], results[7]);
  await suggest(db, 'COFFEE   Shabbos');
  assert.equal(queries.length, 2);
  now += 60001;
  await suggest(db, 'coffee shabbos');
  assert.equal(queries.length, 4);
  const empty = database();
  t.after(() => empty.sqlite.close());
  assert.deepEqual(await suggest(empty.db, 'coffee shabbos'), []);
  for (let i = 0; i < 65; i++) await suggest(db, 'unique ' + i);
  const count = queries.length;
  await suggest(db, 'coffee shabbos');
  assert.equal(queries.length, count + 2);
});

void test('a failed read clears the in-flight entry so the next request can recover', async (t) => {
  const { db, sqlite } = database();
  t.after(() => sqlite.close());
  await seed(db);
  let fail = true;
  const unreliable = {
    prepare(sql) {
      if (fail) throw new Error('Temporary storage failure');
      return db.prepare(sql);
    },
    batch: db.batch,
  };
  const suggest = createShiurAutocomplete();
  await assert.rejects(suggest(unreliable, 'coffee shabbos'));
  fail = false;
  assert.equal((await suggest(unreliable, 'coffee shabbos')).length, 6);
});

void test('short and oversized queries avoid database access, and user syntax cannot become operators', async (t) => {
  const { db, sqlite, queries } = database();
  t.after(() => sqlite.close());
  assert.deepEqual(await findShiurSuggestions(db, ''), []);
  assert.deepEqual(await findShiurSuggestions(db, 'co'), []);
  await assert.rejects(findShiurSuggestions(db, 'a'.repeat(301)), RangeError);
  await assert.rejects(
    findShiurSuggestions(
      db,
      Array.from({ length: 13 }, (_, i) => 'word' + i).join(' '),
    ),
    RangeError,
  );
  assert.equal(queries.length, 0);
  const query = titleAutocompleteQuery('coffee" OR shiurtitle:* -shabbos');
  assert.ok(!query.sqlite.includes('shiurtitle:'));
  assert.ok(!query.postgres.includes('shiurtitle:'));
  assert.ok(!query.sqlite.includes('NOT'));
  assert.match(query.sqlite, / AND /);
});

void test('PostgreSQL uses its GIN expression with bound tsqueries and a bounded candidate set', async (t) => {
  let sql, params;
  const { db, sqlite } = database();
  t.after(() => sqlite.close());
  await seed(db);
  const postgres = {
    dialect: 'postgres',
    batch: db.batch,
    prepare(query) {
      if (!query.includes('to_tsvector')) return db.prepare(query);
      sql = postgresSearchSql(query);
      return {
        bind(...values) {
          params = values;
          return {
            all: async () => ({
              results: [{ id: 1, title: 'Coffee Shabbos' }],
            }),
          };
        },
      };
    },
  };
  assert.equal(
    (await findShiurSuggestions(postgres, 'coffee shabbos')).length,
    1,
  );
  assert.match(sql, /yutorah_search\.search_title_catalog/);
  assert.match(sql, /to_tsquery\('simple',\$1\)/);
  assert.match(sql, /to_tsquery\('simple',\$2\)/);
  assert.match(sql, /LIMIT 50/);
  assert.equal(params[0], params[1]);
  assert.match(params[0], /'coffee':\*/);
  assert.match(
    readFileSync('db/search-postgres/002_autocomplete.sql', 'utf8'),
    /USING gin \(to_tsvector\('simple', title\)\)/,
  );
});

void test('title lookup uses the full-text index and stays bounded across 100,000 titles', async (t) => {
  const { db, sqlite } = database();
  t.after(() => sqlite.close());
  const insert = sqlite.prepare(
    'INSERT INTO search_title_catalog(id,title,terms) VALUES(?,?,?)',
  );
  sqlite.exec('BEGIN');
  for (let i = 1; i <= 100000; i++)
    insert.run(i, 'Daily Torah Learning ' + i, '[]');
  sqlite.exec('COMMIT');
  await seed(db);
  const plan = sqlite
    .prepare(
      'EXPLAIN QUERY PLAN SELECT rowid,title FROM search_title_autocomplete WHERE search_title_autocomplete MATCH ? ORDER BY rank LIMIT 50',
    )
    .all('"coffee"* AND "shabbos"*');
  assert.ok(plan.some((row) => /VIRTUAL TABLE INDEX/.test(row.detail)));
  const start = performance.now();
  const items = await findShiurSuggestions(db, 'coffee in shabbos');
  const elapsed = performance.now() - start;
  assert.equal(items.length, 6);
  assert.ok(
    elapsed < 1000,
    'Must query the index, not read the archive into JavaScript',
  );
  t.diagnostic(`100,000-title lookup: ${elapsed.toFixed(1)} ms`);
});

const { GET } = await load('app/api/suggestions/route.ts', {
  plugins: [
    {
      name: 'test-storage',
      setup(build) {
        build.onResolve({ filter: /lib\/search-db$/ }, () => ({
          path: 'test-storage',
          namespace: 'test',
        }));
        build.onResolve({ filter: /lib\/catalog-server$/ }, () => ({
          path: 'test-catalog',
          namespace: 'test',
        }));
        build.onLoad({ filter: /test-storage/, namespace: 'test' }, () => ({
          contents:
            'export function searchDatabase() { if (!globalThis.__autocompleteDatabase) throw new Error("Storage unavailable"); return globalThis.__autocompleteDatabase; }',
          loader: 'js',
        }));
        build.onLoad({ filter: /test-catalog/, namespace: 'test' }, () => ({
          contents: `
            export const deferCatalogWork = () => {};
            export async function getCatalogService() {
              return { suggestions: async () => {
                if (!globalThis.__autocompleteCatalog) throw new Error('Catalog unavailable');
                return globalThis.__autocompleteCatalog;
              } };
            }
          `,
          loader: 'js',
        }));
      },
    },
  ],
});

void test('suggestions endpoint bounds input, returns compact cacheable titles, and handles storage failure', async (t) => {
  const { db, sqlite } = database();
  t.after(() => {
    sqlite.close();
    delete globalThis.__autocompleteDatabase;
    delete globalThis.__autocompleteCatalog;
  });
  await seed(db);
  assert.equal(
    (await GET(new Request('http://localhost/api/suggestions?q=co'))).status,
    200,
  );
  assert.equal(
    (
      await GET(
        new Request('http://localhost/api/suggestions?q=' + 'a'.repeat(301)),
      )
    ).status,
    400,
  );
  globalThis.__autocompleteDatabase = db;
  globalThis.__autocompleteCatalog = { items: [], partial: false };
  const response = await GET(
    new Request('http://localhost/api/suggestions?q=coffee%20in%20shabbos'),
  );
  assert.match(response.headers.get('cache-control'), /max-age=60/);
  const body = await response.json();
  assert.equal(body.items.length, 6);
  assert.deepEqual(Object.keys(body.items[0]).sort(), [
    'context',
    'id',
    'kind',
    'name',
  ]);
  delete globalThis.__autocompleteDatabase;
  delete globalThis.__autocompleteCatalog;
  const failed = await GET(
    new Request('http://localhost/api/suggestions?q=coffee'),
  );
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
});

void test('suggestions endpoint mixes catalog titles with shiurim and keeps successful sources on partial failure', async (t) => {
  const { db, sqlite } = database();
  t.after(() => {
    sqlite.close();
    delete globalThis.__autocompleteDatabase;
    delete globalThis.__autocompleteCatalog;
  });
  await seed(db);
  const catalog = {
    items: [
      {
        id: 40,
        kind: 'collection',
        name: 'Coffee Shabbos',
        count: 1,
        context: 'Collection',
      },
      {
        id: 41,
        kind: 'series',
        name: 'Coffee Shabbos: A Practical Guide',
        count: 50000,
        context: 'Series',
      },
    ],
    partial: false,
  };
  globalThis.__autocompleteDatabase = db;
  globalThis.__autocompleteCatalog = catalog;
  const request = () =>
    GET(new Request('http://localhost/api/suggestions?q=coffee%20shabbos'));
  const body = await (await request()).json();
  assert.ok(body.items.find((item) => item.kind === 'collection'));
  assert.ok(body.items.find((item) => item.kind === 'series'));
  assert.ok(
    body.items.findIndex((item) => item.id === 1) <
      body.items.findIndex((item) => item.kind === 'series'),
  );
  delete globalThis.__autocompleteDatabase;
  const withoutTitles = await request();
  assert.equal(withoutTitles.status, 200);
  assert.equal(withoutTitles.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await withoutTitles.json(), { ...catalog, partial: true });
  globalThis.__autocompleteDatabase = db;
  delete globalThis.__autocompleteCatalog;
  const withoutCatalog = await request();
  assert.equal(withoutCatalog.status, 200);
  assert.ok(
    (await withoutCatalog.json()).items.every((item) => item.kind === 'shiur'),
  );
});
