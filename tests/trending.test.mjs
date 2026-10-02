import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

async function load(path, plugins = []) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins,
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}
const { trendingPeriods, trendingWindow, rankTrending, parseTrendingOptions } =
  await load('lib/trending.ts');
const { getDiscovery, createDiscoveryReader } = await load('lib/discovery.ts');
const { createTrendingService, TrendingBusyError, TrendingChangedError } =
  await load('lib/trending-cache.ts');
const initial = Date.parse('2026-10-02T12:00:00Z');
const options = { period: 'week', minutes: 0 };
const raw = (id, extra = {}) => ({
  shiurid: id,
  shiurtitle: `Shiur ${id}`,
  shiurdatesubmitted: '2026-10-01T12:00:00Z',
  shiurvisitsnum: 10,
  duration: 5,
  ...extra,
});
const shiur = (id, extra = {}) => ({
  id,
  views: 10,
  uploadedAt: '2026-10-01T12:00:00Z',
  duration: 300,
  topics: [],
  ...extra,
});
const snapshot = (selected = options, now = initial) => ({
  trending: [shiur(1)],
  total: 1,
  sampled: 1,
  partial: false,
  fetchedAt: new Date(now).toISOString(),
  ...selected,
  ...trendingWindow(selected.period, now),
  dateBasis: 'upload-date',
  stale: false,
});

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  const prepare = (sql, values = []) => ({
    bind: (...args) => prepare(sql, args),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => ({
      meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) },
    }),
  });
  return { db: { prepare }, sqlite };
}

void test('all five periods have fixed rolling cutoffs, including leap years and daylight saving', () => {
  const now = Date.parse('2024-03-10T08:00:00Z');
  for (const { value, days } of trendingPeriods) {
    const window = trendingWindow(value, now);
    assert.equal(window.before, new Date(now).toISOString());
    assert.equal(
      window.after,
      days ? new Date(now - days * 86400000).toISOString() : null,
    );
  }
  assert.deepEqual(parseTrendingOptions(new URLSearchParams()), options);
  for (const period of ['day', 'week', 'month', 'year', 'all'])
    assert.equal(
      parseTrendingOptions(new URLSearchParams({ period })).period,
      period,
    );
  for (const params of [
    { period: 'today' },
    { minutes: '-1' },
    { minutes: '1000' },
    { minutes: 'NaN' },
  ])
    assert.throws(
      () => parseTrendingOptions(new URLSearchParams(params)),
      RangeError,
    );
});

void test('cohort ranking uses total views and includes cutoff boundaries while excluding invalid and future dates', () => {
  const after = trendingWindow('week', initial).after;
  const items = [
    shiur(1, { views: 500, uploadedAt: '2000-01-01' }),
    shiur(2, { views: 100, uploadedAt: after }),
    shiur(3, { views: 80, uploadedAt: new Date(initial).toISOString() }),
    shiur(4, { views: 400, uploadedAt: 'invalid' }),
    shiur(5, { views: 1000, uploadedAt: new Date(initial + 1).toISOString() }),
    shiur(6, { views: Infinity }),
    shiur(7, { views: -1 }),
    shiur(8, { views: undefined }),
  ];
  assert.deepEqual(
    rankTrending(items, 30, options, initial).map((s) => s.id),
    [2, 3],
  );
  assert.deepEqual(
    rankTrending(
      items.slice(0, 4),
      30,
      { ...options, period: 'all' },
      initial,
    ).map((s) => s.id),
    [1, 4, 2, 3],
  );
});

void test('duration filtering precedes limiting and view ties have deterministic ID order', () => {
  assert.deepEqual(
    rankTrending(
      [
        shiur(1, { views: 100, duration: 3600 }),
        shiur(2),
        shiur(3),
        shiur(4, { duration: 0 }),
      ],
      1,
      { ...options, minutes: 10 },
      initial,
    ).map((s) => s.id),
    [3],
  );
});

void test('source queries use upload cutoffs and duration before scanning every matching ID', async () => {
  const original = globalThis.fetch;
  let target;
  globalThis.fetch = async (url) => {
    target = new URL(url);
    return Response.json({ response: { numFound: 1, docs: [raw(1)] } });
  };
  try {
    for (const { value } of trendingPeriods) {
      const result = await getDiscovery(
        { period: value, minutes: 10 },
        initial,
      );
      assert.equal(target.pathname, '/Search/GetSearchResults');
      assert.match(target.searchParams.get('sort_by'), /^shiurid desc/);
      const filters = target.searchParams.get('facet_query');
      assert.match(filters, /teacherishidden:0/);
      assert.match(filters, /duration:\[1 TO 10\]/);
      assert.equal(filters.includes('shiurdatesubmitted:'), value !== 'all');
      if (value !== 'all') assert.ok(filters.includes(result.before));
      assert.equal(result.period, value);
      assert.equal(result.trending[0].views, 10);
    }
  } finally {
    globalThis.fetch = original;
  }
});

void test('empty cohorts and zero views are valid; malformed pages, ignored filters and duplicate IDs fail closed', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ response: { numFound: 0, docs: [] } });
    assert.deepEqual((await getDiscovery(options, initial)).trending, []);
    for (const docs of [
      [raw(1, { shiurdatesubmitted: '2000-01-01' })],
      [raw(1, { shiurvisitsnum: undefined })],
      [raw(1), raw(2)],
      [raw(1), raw(1)],
      [raw(1, { shiurdatesubmitted: '2026-10-03T12:00:00Z' })],
    ]) {
      globalThis.fetch = async () =>
        Response.json({ response: { numFound: docs.length, docs } });
      await assert.rejects(
        getDiscovery(options, initial),
        /invalid trending data/,
      );
    }
    globalThis.fetch = async () =>
      Response.json({ response: { numFound: 31, docs: [raw(1)] } });
    await assert.rejects(getDiscovery(options, initial), /incomplete/);
    globalThis.fetch = async () =>
      Response.json({
        response: { numFound: 1, docs: [raw(1, { duration: 60 })] },
      });
    await assert.rejects(
      getDiscovery({ ...options, minutes: 10 }, initial),
      /invalid trending/,
    );
    globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
    await assert.rejects(getDiscovery(options, initial), /503/);
  } finally {
    globalThis.fetch = original;
  }
});

void test('all-time ranking includes viewed archival shiurim with missing upload dates', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      response: {
        numFound: 1,
        docs: [raw(1, { shiurdatesubmitted: undefined })],
      },
    });
  try {
    const result = await getDiscovery({ ...options, period: 'all' }, initial);
    assert.equal(result.partial, false);
    assert.equal(result.trending[0].id, 1);
    await assert.rejects(
      getDiscovery(options, initial),
      /invalid trending data/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

void test('resuming a complete cohort finds winners beyond the first page and freezes the date window', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const params = new URL(url).searchParams;
    requests.push(params);
    const remaining = requests.length === 1 ? 60 : 30;
    const maximum = remaining;
    return Response.json({
      response: {
        numFound: remaining,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(maximum - i, { shiurvisitsnum: maximum === 60 ? 1 : 1000 - i }),
        ),
      },
    });
  };
  try {
    const first = await getDiscovery(options, initial);
    assert.equal(first.partial, true);
    assert.equal(first.sampled, 30);
    const complete = await getDiscovery(options, initial + 10000, first);
    assert.equal(complete.partial, false);
    assert.equal(complete.sampled, 60);
    assert.equal(complete.total, 60);
    assert.equal(complete.before, first.before);
    assert.ok(requests[1].get('facet_query').includes('shiurid:[1 TO 30]'));
    assert.equal(complete.trending[0].id, 30);
    assert.ok(complete.trending.every((s) => s.id <= 30));
    globalThis.fetch = async () =>
      Response.json({
        response: {
          numFound: 29,
          docs: Array.from({ length: 29 }, (_, i) => raw(30 - i)),
        },
      });
    await assert.rejects(
      getDiscovery(options, initial + 10000, first),
      /cohort changed/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

const { normalize, uploadDate } = await load('lib/yutorah.ts');
void test('a Cloudflare-blocked website falls back to complete mobile indexing without duplicate coverage', async () => {
  const original = globalThis.fetch;
  let websiteCalls = 0,
    mobileCalls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/Search/GetSearchResults') {
      websiteCalls++;
      return new Response('challenge', { status: 403 });
    }
    mobileCalls++;
    const page = Number(u.searchParams.get('start'));
    const maximum = 150 - (page - 1) * 30 + (mobileCalls === 2 ? 1 : 0);
    return Response.json({
      response: {
        numFound: 150,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(maximum - i, { shiurvisitsnum: page === 5 ? 1000 - i : 1 }),
        ),
      },
    });
  };
  try {
    const first = await getDiscovery(options, initial);
    assert.equal(first.source, 'mobile');
    assert.equal(first.partial, true);
    assert.equal(first.sampled, 119);
    assert.equal(first.libraryTotal, 150);
    assert.ok(first.seen.length > 0);
    const second = await getDiscovery(options, initial + 10000, first);
    assert.equal(second.sampled, 149);
    assert.equal(second.partial, true);
    assert.equal(second.nextPage, 1);
    const complete = await getDiscovery(options, initial + 20000, second);
    assert.equal(complete.sampled, 150);
    assert.equal(complete.total, 150);
    assert.equal(complete.partial, false);
    assert.equal(complete.seen, undefined);
    assert.equal(complete.before, first.before);
    assert.equal(complete.trending[0].id, 30);
    assert.equal(websiteCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

void test('ignored website date filters use the independently validated mobile cohort', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/Search/GetSearchResults')
      return Response.json({
        response: {
          numFound: 1,
          docs: [raw(1, { shiurdatesubmitted: '2000-01-01T12:00:00Z' })],
        },
      });
    return Response.json({
      response: {
        numFound: 1,
        docs: u.searchParams.get('start') === '1' ? [raw(2)] : [],
      },
    });
  };
  try {
    const result = await getDiscovery(options, initial);
    assert.equal(result.source, 'mobile');
    assert.equal(result.partial, false);
    assert.deepEqual(
      result.trending.map((s) => s.id),
      [2],
    );
  } finally {
    globalThis.fetch = original;
  }
});

void test('period switches share cached source pages and concurrent variants coalesce mobile requests', async () => {
  const original = globalThis.fetch;
  let now = initial,
    calls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/Search/GetSearchResults')
      return new Response('', { status: 403 });
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const page = Number(u.searchParams.get('start'));
    return Response.json({
      response: {
        numFound: 120,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(120 - (page - 1) * 30 - i, {
            shiurdatesubmitted: new Date(initial - 3600000).toISOString(),
          }),
        ),
      },
    });
  };
  try {
    const read = createDiscoveryReader(() => now);
    const results = await Promise.all([
      read({ period: 'day', minutes: 0 }, now),
      read(options, now),
    ]);
    assert.equal(calls, 4);
    assert.equal(results[0].period, 'day');
    assert.equal(results[1].period, 'week');
    await read({ period: 'month', minutes: 0 }, now);
    assert.equal(calls, 4);
    now += 60000;
    await read({ period: 'all', minutes: 0 }, now);
    assert.equal(calls, 8);
  } finally {
    globalThis.fetch = original;
  }
});

void test('failed mobile pages preserve successful progress and are revisited before completion', async () => {
  const original = globalThis.fetch;
  let failed = false;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/Search/GetSearchResults')
      return new Response('', { status: 403 });
    const page = Number(u.searchParams.get('start'));
    if (page === 2 && !failed) {
      failed = true;
      throw new Error('temporary page failure');
    }
    return Response.json({
      response: {
        numFound: 150,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(150 - (page - 1) * 30 - i, {
            shiurvisitsnum: page === 2 ? 1000 - i : 1,
          }),
        ),
      },
    });
  };
  try {
    const first = await getDiscovery(options, initial);
    assert.equal(first.sampled, 90);
    assert.equal(first.partial, true);
    const second = await getDiscovery(options, initial + 10000, first);
    assert.equal(second.sampled, 120);
    assert.equal(second.partial, true);
    const complete = await getDiscovery(options, initial + 20000, second);
    assert.equal(complete.sampled, 150);
    assert.equal(complete.partial, false);
    assert.equal(complete.trending[0].id, 120);
  } finally {
    globalThis.fetch = original;
  }
});

void test('mobile coverage and upload filtering survive a persistent server restart', async () => {
  const original = globalThis.fetch;
  const { db, sqlite } = database();
  let now = initial,
    websiteCalls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/Search/GetSearchResults') {
      websiteCalls++;
      return new Response('', { status: 403 });
    }
    const page = Number(u.searchParams.get('start'));
    return Response.json({
      response: {
        numFound: 150,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(150 - (page - 1) * 30 - i, {
            shiurdatesubmitted:
              page === 1 ? '2000-01-01T12:00:00Z' : '2026-10-01T12:00:00Z',
          }),
        ),
      },
    });
  };
  try {
    const config = { database: () => db, now: () => now, read: getDiscovery };
    const first = await createTrendingService(config)(options);
    assert.equal(first.sampled, 120);
    assert.equal(first.total, 90);
    now += 3500;
    const complete = await createTrendingService(config)(options);
    assert.equal(complete.sampled, 150);
    assert.equal(complete.total, 120);
    assert.equal(complete.partial, false);
    assert.equal(websiteCalls, 1);
    assert.equal((await createTrendingService(config)(options)).total, 120);
  } finally {
    globalThis.fetch = original;
    sqlite.close();
  }
});

void test('upload timestamps remain separate from recorded dates and preserve Eastern offsets and milliseconds', () => {
  assert.equal(
    uploadDate('2026-10-02T14:01:11.56'),
    '2026-10-02T18:01:11.560Z',
  );
  assert.equal(uploadDate('2026-01-02T14:01:11'), '2026-01-02T19:01:11.000Z');
  assert.equal(uploadDate('2026-10-02T18:01:11Z'), '2026-10-02T18:01:11.000Z');
  for (const input of [null, undefined, 'invalid', '2026-10-02'])
    assert.equal(uploadDate(input), undefined);
  const item = normalize(
    raw(1, {
      shiurdate: '2000-01-01T12:00:00Z',
      teacherfullname: ['Rabbi Example'],
      teacherid: [23],
      photo: ['rabbi.jpg'],
    }),
  );
  assert.equal(item.date, '2000-01-01T12:00:00Z');
  assert.equal(item.uploadedAt, '2026-10-01T12:00:00.000Z');
  assert.equal(item.teacher, 'Rabbi Example');
  assert.equal(item.teacherId, 23);
  assert.ok(item.image.endsWith('/rabbi.jpg'));
  assert.equal(rankTrending([item], 30, options, initial).length, 1);
  assert.equal(
    rankTrending(
      [shiur(2, { date: '2026-10-01', uploadedAt: undefined })],
      30,
      options,
      initial,
    ).length,
    0,
  );
});

void test('unfinished indexing survives a server restart and resumes the saved cursor', async () => {
  const { db, sqlite } = database();
  let now = initial;
  const first = {
    ...snapshot(),
    total: 60,
    sampled: 30,
    partial: true,
    nextId: 30,
  };
  const config = {
    database: () => db,
    now: () => now,
    read: async (selected, at, previous) => {
      if (!previous) return first;
      assert.equal(previous.nextId, 30);
      assert.equal(previous.before, first.before);
      return { ...snapshot(selected, at), total: 60, sampled: 60 };
    },
  };
  assert.equal((await createTrendingService(config)(options)).partial, true);
  now += 3500;
  const finished = await createTrendingService(config)(options);
  assert.equal(finished.partial, false);
  assert.equal(finished.sampled, 60);
  sqlite.close();
});

void test('concurrent requests share a fetch; cached data expires after five minutes and variants stay separate', async () => {
  let now = initial,
    calls = 0;
  const service = createTrendingService({
    now: () => now,
    read: async (selected, at) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return snapshot(selected, at);
    },
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => service(options)),
  );
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result === results[0]));
  await service(options);
  await service({ ...options, period: 'month' });
  await service({ ...options, minutes: 10 });
  assert.equal(calls, 3);
  now += 300000;
  await service(options);
  assert.equal(calls, 4);
});

void test('cache survives a new server instance without altering metadata-search runs or creating candidate hits', async () => {
  const { db, sqlite } = database();
  sqlite.exec(
    "INSERT INTO search_runs VALUES ('ordinary','sha256','{}',0,1,1,0)",
  );
  let calls = 0;
  const config = {
    database: () => db,
    now: () => initial,
    read: async () => {
      calls++;
      return snapshot();
    },
  };
  await createTrendingService(config)(options);
  const result = await createTrendingService(config)(options);
  assert.equal(calls, 1);
  assert.equal(result.total, 1);
  assert.equal(
    sqlite.prepare('SELECT count(*) AS n FROM search_hits').get().n,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT plan FROM search_runs WHERE id='ordinary'").get()
      .plan,
    '{}',
  );
  assert.equal(
    sqlite.prepare('SELECT count(*) AS n FROM search_runs').get().n,
    2,
  );
  sqlite.close();
});

void test('storage leases prevent separate server instances from issuing duplicate cold requests', async () => {
  const { db, sqlite } = database();
  let resolveRead;
  const config = {
    database: () => db,
    now: () => initial,
    read: () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  };
  const first = createTrendingService(config)(options);
  while (!resolveRead) await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(
    createTrendingService(config)(options),
    TrendingBusyError,
  );
  resolveRead(snapshot());
  await first;
  assert.equal(sqlite.prepare('SELECT lease FROM search_runs').get().lease, 0);
  sqlite.close();
});

void test('upstream failures preserve the last snapshot, bound retries, and expire stale data after a day', async () => {
  const { db, sqlite } = database();
  let now = initial,
    calls = 0,
    failing = false;
  const service = createTrendingService({
    database: () => db,
    now: () => now,
    read: async (selected, at) => {
      calls++;
      if (failing) throw new Error('offline');
      return snapshot(selected, at);
    },
  });
  await service(options);
  now += 300000;
  failing = true;
  const stale = await service(options);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, new Date(initial).toISOString());
  await service(options);
  assert.equal(calls, 2);
  const persisted = JSON.parse(
    sqlite.prepare('SELECT plan FROM search_runs').get().plan,
  ).snapshot;
  assert.equal(persisted.stale, false);
  assert.equal(persisted.fetchedAt, stale.fetchedAt);
  now = initial + 86400000;
  await assert.rejects(service(options), /offline/);
  sqlite.close();
});

void test('changed cohorts discard the unfinished cursor and restart after the retry cooldown', async () => {
  const { db, sqlite } = database();
  let now = initial,
    calls = 0;
  const service = createTrendingService({
    database: () => db,
    now: () => now,
    read: async (selected, at, previous) => {
      calls++;
      if (calls === 2) throw new TrendingChangedError('cohort changed');
      assert.equal(previous, undefined);
      return {
        ...snapshot(selected, at),
        total: 60,
        sampled: 30,
        partial: true,
        nextId: 30,
      };
    },
  });
  await service(options);
  now += 3500;
  await assert.rejects(service(options), TrendingChangedError);
  const saved = JSON.parse(
    sqlite.prepare('SELECT plan FROM search_runs').get().plan,
  );
  assert.equal(saved.snapshot, undefined);
  now += 30000;
  assert.equal((await service(options)).partial, true);
  assert.equal(calls, 3);
  sqlite.close();
});

void test('a failed rebuild preserves the completed chart across server restarts', async () => {
  const { db, sqlite } = database();
  let now = initial,
    calls = 0;
  const config = {
    database: () => db,
    now: () => now,
    read: async (selected, at) => {
      calls++;
      if (calls === 1) return snapshot(selected, at);
      if (calls === 2)
        return {
          ...snapshot(selected, at),
          sampled: 30,
          total: 60,
          partial: true,
          nextId: 30,
        };
      throw new Error('offline');
    },
  };
  const service = createTrendingService(config);
  await service(options);
  now += 300000;
  assert.equal((await service(options)).partial, true);
  now += 3500;
  const retained = await createTrendingService(config)(options);
  assert.equal(retained.stale, true);
  assert.equal(retained.partial, false);
  assert.equal(retained.fetchedAt, new Date(initial).toISOString());
  const saved = JSON.parse(
    sqlite.prepare('SELECT plan FROM search_runs').get().plan,
  );
  assert.equal(saved.snapshot.nextId, 30);
  assert.equal(saved.lastComplete.partial, false);
  sqlite.close();
});

void test('missing storage and corrupt persisted JSON rebuild from the upstream source', async () => {
  const offline = createTrendingService({
    database: () => {
      throw new Error('no storage');
    },
    now: () => initial,
    read: async () => snapshot(),
  });
  assert.equal((await offline(options)).stale, false);
  const { db, sqlite } = database();
  sqlite
    .prepare('INSERT INTO search_runs VALUES (?,?,?,?,?,?,?)')
    .run(
      'trending:v1:week:0',
      'trending:v1:week:0',
      '{broken',
      0,
      1,
      initial,
      0,
    );
  const service = createTrendingService({
    database: () => db,
    now: () => initial,
    read: async () => snapshot(),
  });
  assert.equal((await service(options)).trending.length, 1);
  sqlite.close();
});

const { GET } = await load('app/api/discover/route.ts', [
  {
    name: 'cloudflare-test',
    setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
        path: 'workers',
        namespace: 'test',
      }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export const env = {};',
      }));
    },
  },
]);
void test('endpoint rejects bad period and duration values before any upstream or storage requests', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('unexpected fetch');
  };
  try {
    for (const query of [
      'period=today',
      'minutes=9999',
      'period=week&minutes=-1',
    ])
      assert.equal(
        (await GET(new Request('http://localhost/api/discover?' + query)))
          .status,
        400,
      );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

void test('the public endpoint strips the internal library coverage bitmap', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/Search/GetSearchResults')
      return new Response('', { status: 403 });
    const page = Number(u.searchParams.get('start'));
    return Response.json({
      response: {
        numFound: 150,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(150 - (page - 1) * 30 - i, {
            shiurdatesubmitted: new Date(Date.now() - 3600000).toISOString(),
          }),
        ),
      },
    });
  };
  try {
    const response = await GET(
      new Request('http://localhost/api/discover?period=day'),
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.seen, undefined);
    assert.equal(data.source, 'mobile');
    assert.equal(data.sampled, 120);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally {
    globalThis.fetch = original;
  }
});
