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
const { loadDiscovery } = await load('lib/discovery-client.ts');
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
    assert.equal(
      sqlite.prepare('SELECT total FROM search_runs').get().total,
      150,
    );
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
    "INSERT INTO search_runs(id,fingerprint,plan,total,next,created,lease) VALUES ('ordinary','sha256','{}',0,1,1,0)",
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
    .prepare(
      'INSERT INTO search_runs(id,fingerprint,plan,total,next,created,lease) VALUES (?,?,?,?,?,?,?)',
    )
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
        numFound: 600,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(600 - (page - 1) * 30 - i, {
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
    assert.equal(data.sampled, 360);
    assert.equal(data.index, undefined);
    assert.equal(data.nextPage, undefined);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally {
    globalThis.fetch = original;
  }
});

void test('default trending shares durable scan progress across month, year and duration charts', async () => {
  const original = globalThis.fetch;
  const { db, sqlite } = database();
  let now = initial;
  const pages = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/Search/GetSearchResults')
      return new Response('', { status: 403 });
    const page = Number(u.searchParams.get('start'));
    pages.push(page);
    return Response.json({
      response: {
        numFound: 600,
        docs: Array.from(
          { length: Math.min(30, Math.max(0, 600 - (page - 1) * 30)) },
          (_, i) =>
            raw(600 - (page - 1) * 30 - i, {
              shiurvisitsnum: page === 20 ? 1000 : 10,
              shiurdatesubmitted: '2026-09-20T12:00:00Z',
            }),
        ),
      },
    });
  };
  try {
    const config = { database: () => db, now: () => now };
    const first = await createTrendingService(config)({
      period: 'month',
      minutes: 0,
    });
    now += 3500;
    const next = await createTrendingService(config)({
      period: 'year',
      minutes: 10,
    });
    assert.ok(
      next.sampled > first.sampled,
      'Changing chart must resume the same saved library scan',
    );
    assert.equal(
      next.partial,
      false,
      '600 records must finish in two bounded passes',
    );
    const month = await createTrendingService(config)({
      period: 'month',
      minutes: 0,
    });
    assert.equal(month.partial, false);
    assert.equal(
      month.trending[0].id,
      30,
      'The final page winner must reach every matching chart',
    );
    assert.equal(month.total, 600);
    assert.equal(
      sqlite.prepare('SELECT count(*) AS n FROM search_runs').get().n,
      1,
    );
    assert.equal(
      new Set(pages).size,
      pages.length - 1,
      'Only the shared head reconciliation is repeated; charts do not start separate scans',
    );
  } finally {
    globalThis.fetch = original;
    sqlite.close();
  }
});

const { readTrendingResponse } = await load('lib/trending-source.ts');

void test('the warmer retries stale responses and never reports a stale chart as complete', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const originalLog = console.log;
  const originalToken = process.env.TRENDING_REFRESH_TOKEN;
  const originalExit = process.exitCode;
  try {
    process.env.TRENDING_REFRESH_TOKEN = 'fixture-refresh-token';
    for (const maxPasses of [3, 2]) {
      let calls = 0;
      const delays = [],
        logs = [];
      process.exitCode = undefined;
      console.log = (message) => logs.push(message);
      globalThis.setTimeout = (callback, delay) => {
        delays.push(delay);
        queueMicrotask(callback);
        return 0;
      };
      globalThis.fetch = async (url, init) => {
        calls++;
        assert.equal(new URL(url).pathname, '/api/discover/refresh');
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(
          init.headers.Authorization,
          'Bearer fixture-refresh-token',
        );
        return Response.json({
          ...snapshot({ period: 'all', minutes: 0 }),
          stale: calls < 3,
        });
      };
      await load('scripts/warm-trending.ts', [
        {
          name: 'warm-options',
          setup(build) {
            build.onResolve({ filter: /^node:util$/ }, () => ({
              path: 'args',
              namespace: 'mock',
            }));
            build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
              contents: `export const parseArgs = () => ({values: ${JSON.stringify({ url: 'https://fixture.test', period: 'all', refresh: true, minutes: '0', 'max-passes': String(maxPasses) })}});`,
            }));
          },
        },
      ]);
      assert.equal(calls, maxPasses);
      assert.deepEqual(delays, [30000, 60000]);
      assert.equal(
        logs.filter((line) => line.includes(', complete')).length,
        maxPasses === 3 ? 1 : 0,
      );
      assert.equal(process.exitCode, maxPasses === 3 ? undefined : 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
    console.log = originalLog;
    process.exitCode = originalExit;
    if (originalToken === undefined) delete process.env.TRENDING_REFRESH_TOKEN;
    else process.env.TRENDING_REFRESH_TOKEN = originalToken;
  }
});

void test('saved chart requests serve persisted completed charts without waiting for upstream refresh', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const { db, sqlite } = database();
  globalThis.__trendingTestDatabase = db;
  let calls = 0;
  try {
    globalThis.fetch = async () =>
      Response.json({
        response: {
          numFound: 30,
          docs: Array.from({ length: 30 }, (_, i) => raw(30 - i)),
        },
      });
    await createTrendingService({ database: () => db, now: () => initial })({
      period: 'all',
      minutes: 0,
    });
    Date.now = () => initial + 12 * 3600000;
    globalThis.fetch = async () => {
      calls++;
      throw new Error('A chart request must not wait for upstream.');
    };
    const { GET: cached } = await load('app/api/discover/route.ts', [
      {
        name: 'persisted-chart',
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/search-db$/ }, () => ({
            path: 'db',
            namespace: 'mock',
          }));
          build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
            contents:
              'export const searchDatabase = () => globalThis.__trendingTestDatabase;',
          }));
        },
      },
    ]);
    for (const period of ['day', 'week', 'month', 'year', 'all']) {
      const response = await cached(
        new Request(
          `http://localhost/api/discover?period=${period}&minutes=10&cached=1`,
        ),
      );
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.partial, false);
      assert.equal(data.period, period);
      assert.equal(data.fetchedAt, new Date(initial).toISOString());
      assert.equal(data.index, undefined);
      assert.equal(data.seen, undefined);
    }
    assert.equal(
      calls,
      0,
      'Serving a saved chart must not issue upstream requests',
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    delete globalThis.__trendingTestDatabase;
    sqlite.close();
  }
});

void test('a direct Trending load publishes persisted rankings before a blocked indexing request completes', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const { db, sqlite } = database();
  globalThis.__trendingDirectTestDatabase = db;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let request;
  try {
    const upstream = async (url) => {
      const page = Number(new URL(url).searchParams.get('start'));
      return Response.json({
        response: {
          numFound: 600,
          docs: Array.from({ length: 30 }, (_, i) =>
            raw(600 - (page - 1) * 30 - i),
          ),
        },
      });
    };
    globalThis.fetch = upstream;
    await createTrendingService({ database: () => db, now: () => initial })(
      options,
    );
    Date.now = () => initial + 3500;
    const { GET } = await load('app/api/discover/route.ts', [
      {
        name: 'direct-trending-load',
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/search-db$/ }, () => ({
            path: 'db',
            namespace: 'mock',
          }));
          build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
            contents:
              'export const searchDatabase = () => globalThis.__trendingDirectTestDatabase;',
          }));
        },
      },
    ]);
    let upstreamCalls = 0;
    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.startsWith('/api/discover?'))
        return GET(new Request('http://localhost' + url));
      upstreamCalls++;
      await blocked;
      return upstream(url);
    };
    const updates = [];
    let firstUpdate;
    const visible = new Promise((resolve) => {
      firstUpdate = resolve;
    });
    let finished = false;
    request = loadDiscovery(
      options,
      new AbortController().signal,
      (data) => {
        updates.push(data);
        firstUpdate(data);
      },
      () => {},
      true,
    ).then(() => {
      finished = true;
    });
    const saved = await Promise.race([
      visible,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error('Saved rankings stayed hidden behind indexing')),
          1000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(
      finished,
      false,
      'Saved recordings must appear while indexing is still blocked',
    );
    assert.equal(saved.fetchedAt, new Date(initial).toISOString());
    assert.equal(saved.sampled, 360);
    assert.equal(saved.stale, true);
    assert.ok(saved.trending.length > 0);
    release();
    await request;
    assert.ok(
      upstreamCalls > 0,
      'The regular request must still advance the index',
    );
    assert.equal(updates.at(-1).sampled, 600);
    assert.equal(updates.at(-1).stale, false);
    assert.equal(updates.at(-1).partial, false);
  } finally {
    release();
    await request;
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    delete globalThis.__trendingDirectTestDatabase;
    sqlite.close();
  }
});

void test('a late saved response cannot replace freshly refreshed rankings', async () => {
  const originalFetch = globalThis.fetch;
  let release;
  const saved = new Promise((resolve) => {
    release = resolve;
  });
  const fresh = snapshot(options, initial + 3500);
  const updates = [];
  try {
    globalThis.fetch = async (url) =>
      typeof url === 'string' && url.includes('cached=1')
        ? saved
        : Response.json(fresh);
    await loadDiscovery(
      options,
      new AbortController().signal,
      (data) => updates.push(data),
      () => {},
      true,
    );
    release(Response.json({ ...snapshot(), stale: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates, [fresh]);
  } finally {
    release(Response.json(snapshot()));
    globalThis.fetch = originalFetch;
  }
});

void test('a missing saved chart still allows the regular request to load, and aborted loads publish nothing', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) =>
      typeof url === 'string' && url.includes('cached=1')
        ? new Response('', { status: 503 })
        : Response.json(snapshot());
    const updates = [];
    const retries = [];
    await loadDiscovery(
      options,
      new AbortController().signal,
      (data) => updates.push(data),
      (n) => retries.push(n),
      true,
    );
    assert.deepEqual(updates, [snapshot()]);
    assert.deepEqual(retries, []);
    const abort = new AbortController();
    abort.abort();
    await loadDiscovery(
      options,
      abort.signal,
      (data) => updates.push(data),
      (n) => retries.push(n),
      true,
    );
    assert.equal(updates.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('saved charts retain completed rankings during a multi-day rebuild and never advance its cursor', async () => {
  const { db, sqlite } = database();
  let now = initial;
  let calls = 0;
  const config = {
    database: () => db,
    now: () => now,
    preferCompleted: true,
    read: async (selected, at) => {
      calls++;
      return snapshot(selected, at);
    },
  };
  await createTrendingService(config)(options);
  const complete = JSON.parse(
    sqlite.prepare('SELECT plan FROM search_runs').get().plan,
  ).snapshot;
  const partial = {
    ...complete,
    sampled: 30,
    total: 60,
    partial: true,
    nextId: 30,
    fetchedAt: new Date(initial + 86400000).toISOString(),
  };
  sqlite
    .prepare('UPDATE search_runs SET plan=?')
    .run(JSON.stringify({ snapshot: partial, lastComplete: complete }));
  const plan = sqlite.prepare('SELECT plan FROM search_runs').get().plan;
  now += 2 * 86400000;
  const service = createTrendingService({ ...config, cachedOnly: true });
  const saved = await service(options);
  assert.equal(saved.fetchedAt, complete.fetchedAt);
  assert.equal(saved.partial, false);
  assert.equal(saved.refreshing, true);
  assert.equal(saved.stale, true);
  assert.equal(calls, 1);
  assert.equal(sqlite.prepare('SELECT plan FROM search_runs').get().plan, plan);
  now = initial + 7 * 86400000;
  assert.equal((await service(options)).fetchedAt, complete.fetchedAt);
  assert.equal(sqlite.prepare('SELECT plan FROM search_runs').get().plan, plan);
  sqlite.close();
});

void test('long-range requests serve the saved partial scan during an outage without upstream work or cache mutations', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const { db, sqlite } = database();
  globalThis.__trendingPartialTestDatabase = db;
  try {
    globalThis.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get('start'));
      return Response.json({
        response: {
          numFound: 600,
          docs: Array.from({ length: 30 }, (_, i) =>
            raw(600 - (page - 1) * 30 - i),
          ),
        },
      });
    };
    await createTrendingService({ database: () => db, now: () => initial })({
      period: 'all',
      minutes: 0,
    });
    const before = sqlite.prepare('SELECT * FROM search_runs').get();
    const snapshot = JSON.parse(before.plan).snapshot;
    assert.equal(snapshot.partial, true);
    let calls = 0;
    Date.now = () => initial + 10 * 86400000;
    globalThis.fetch = async () => {
      calls++;
      throw new Error('Upstream is offline');
    };
    const { GET } = await load('app/api/discover/route.ts', [
      {
        name: 'saved-partial-chart',
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/search-db$/ }, () => ({
            path: 'db',
            namespace: 'mock',
          }));
          build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
            contents:
              'export const searchDatabase = () => globalThis.__trendingPartialTestDatabase;',
          }));
        },
      },
    ]);
    for (const period of ['day', 'week', 'month', 'year', 'all']) {
      for (const minutes of [0, 10, 20, 30]) {
        const response = await GET(
          new Request(
            `http://localhost/api/discover?period=${period}&minutes=${minutes}&cached=1`,
          ),
        );
        assert.equal(response.status, 200);
        const chart = await response.json();
        assert.equal(chart.partial, true);
        assert.equal(chart.stale, true);
        assert.equal(chart.refreshing, undefined);
        assert.equal(chart.sampled, 360);
        assert.equal(chart.fetchedAt, snapshot.fetchedAt);
        assert.equal(chart.before, snapshot.before);
        assert.deepEqual(
          chart.trending,
          selectTrendingChart(snapshot, { period, minutes }).trending,
        );
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(
          response.headers.get('X-Trending-Fetched-At'),
          snapshot.fetchedAt,
        );
        for (const key of ['index', 'seen', 'nextId', 'nextPage'])
          assert.equal(chart[key], undefined);
      }
    }
    assert.equal(calls, 0);
    assert.deepEqual(sqlite.prepare('SELECT * FROM search_runs').get(), before);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    delete globalThis.__trendingPartialTestDatabase;
    sqlite.close();
  }
});

void test('a cold saved-chart request returns promptly without starting or mutating a scan', async () => {
  const { db, sqlite } = database();
  let calls = 0;
  const service = createTrendingService({
    database: () => db,
    now: () => initial,
    cachedOnly: true,
    read: async () => {
      calls++;
      return snapshot();
    },
  });
  await assert.rejects(service(options), TrendingBusyError);
  assert.equal(calls, 0);
  assert.equal(
    sqlite.prepare('SELECT count(*) AS n FROM search_runs').get().n,
    0,
  );
  sqlite.close();
});

void test('background refresh requires durable storage and retries cache write failures instead of reporting completion', async () => {
  let calls = 0;
  const read = async () => {
    calls++;
    return snapshot();
  };
  const missing = createTrendingService({ requireStorage: true, read });
  await assert.rejects(missing(options), /persistent storage/);
  assert.equal(calls, 0);
  const { db, sqlite } = database();
  const failing = {
    prepare(sql) {
      if (sql.startsWith('UPDATE search_runs SET plan = ?, total'))
        throw new Error('Storage write failed.');
      return db.prepare(sql);
    },
  };
  const service = createTrendingService({
    database: () => failing,
    requireStorage: true,
    read,
    now: () => initial,
  });
  await assert.rejects(service(options), /Storage write failed/);
  await assert.rejects(service(options), /Storage write failed/);
  assert.equal(
    calls,
    1,
    'A failed write must not leave a completed in-memory chart',
  );
  assert.equal(
    JSON.parse(sqlite.prepare('SELECT plan FROM search_runs').get().plan)
      .snapshot,
    undefined,
  );
  sqlite.close();
});

void test('the protected refresher resumes an existing browser scan and saved requests see its completed charts', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const { db, sqlite } = database();
  globalThis.__trendingTestDatabase = db;
  const pages = [];
  let now = initial;
  try {
    Date.now = () => now;
    globalThis.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get('start'));
      pages.push(page);
      return Response.json({
        response: {
          numFound: 600,
          docs: Array.from({ length: 30 }, (_, i) =>
            raw(600 - (page - 1) * 30 - i),
          ),
        },
      });
    };
    const service = createTrendingService({ database: () => db });
    assert.equal(
      (await service({ period: 'month', minutes: 0 })).partial,
      true,
    );
    const originalPlan = sqlite
      .prepare('SELECT plan FROM search_runs')
      .get().plan;
    const { POST } = await load('app/api/discover/refresh/route.ts', [
      {
        name: 'refresh-test',
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: 'env',
            namespace: 'mock',
          }));
          build.onResolve({ filter: /^@\/lib\/search-db$/ }, () => ({
            path: 'db',
            namespace: 'mock',
          }));
          build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
            contents:
              path === 'env'
                ? 'export const env = { TRENDING_REFRESH_TOKEN: "fixture-token" };'
                : 'export const searchDatabase = () => globalThis.__trendingTestDatabase;',
          }));
        },
      },
    ]);
    for (const authorization of [undefined, 'Bearer wrong-token']) {
      const response = await POST(
        new Request('http://localhost/api/discover/refresh', {
          method: 'POST',
          headers: authorization ? { Authorization: authorization } : {},
        }),
      );
      assert.equal(response.status, 404);
      assert.equal(pages.length, 12);
      assert.equal(
        sqlite.prepare('SELECT plan FROM search_runs').get().plan,
        originalPlan,
      );
    }
    const savedPartial = await createTrendingService({
      database: () => db,
      cachedOnly: true,
    })({
      period: 'year',
      minutes: 0,
    });
    assert.equal(savedPartial.partial, true);
    assert.equal(savedPartial.sampled, 360);
    now += 2 * 86400000;
    const response = await POST(
      new Request('http://localhost/api/discover/refresh?period=all', {
        method: 'POST',
        headers: { Authorization: 'Bearer fixture-token' },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const data = await response.json();
    assert.equal(data.partial, false);
    assert.equal(data.sampled, 600);
    assert.equal(data.index, undefined);
    assert.equal(data.seen, undefined);
    assert.equal(data.nextPage, undefined);
    assert.equal(pages.length, 21);
    assert.equal(new Set(pages).size, 20);
    globalThis.fetch = async () => {
      throw new Error('Unexpected upstream request');
    };
    const saved = createTrendingService({
      database: () => db,
      cachedOnly: true,
    });
    for (const period of ['month', 'year', 'all']) {
      const chart = await saved({ period, minutes: 0 });
      assert.equal(chart.partial, false);
      assert.equal(chart.total, 600);
    }
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    delete globalThis.__trendingTestDatabase;
    sqlite.close();
  }
});
const { readTrendingIndex, selectTrendingChart, validTrendingIndex } =
  await load('lib/trending-index.ts');

void test('trending reads complete results across byte boundaries and cancels unused facets', async () => {
  const docs = [raw(42, { shiurtitle: 'תורה } \\"response\\": { [ test' })];
  const prefix = new TextEncoder().encode(
    JSON.stringify({
      SHIURS_NOTEBOOK: [{ response: 'not the results' }],
      response: { numFound: 1, docs },
    }).slice(0, -1),
  );
  let offset = 0,
    cancelled = false;
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (offset < prefix.length)
            controller.enqueue(prefix.slice(offset, ++offset));
          else
            controller.error(
              new Error('The facet payload must not be consumed'),
            );
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  );
  const result = await readTrendingResponse(response);
  assert.deepEqual(result.response.docs, docs);
  assert.equal(cancelled, true);
  for (const body of [
    '{"response":null}',
    '{"response":{"docs":[]',
    'not JSON',
    '{"response":[',
  ])
    await assert.rejects(readTrendingResponse(new Response(body)), /JSON/);
  await assert.rejects(
    readTrendingResponse(
      new Response('{"response":{"docs":["' + 'a'.repeat(2_000_001) + '"]}}'),
    ),
    /size limit/,
  );
});

void test('one shared traversal computes all twenty exact cohort rankings, including late winners and archived uploads', async () => {
  const original = globalThis.fetch;
  const rows = Array.from({ length: 601 }, (_, i) =>
    raw(601 - i, {
      shiurvisitsnum: i % 7 ? (i * 17) % 113 : 0,
      duration: [0, 5, 15, 25, 45][i % 5],
      shiurdatesubmitted:
        i % 13 === 0
          ? undefined
          : new Date(
              initial - [0, 1, 7, 30, 365, 500, -1][i % 7] * 86400000,
            ).toISOString(),
      shiurdate: '1990-01-01T12:00:00Z',
    }),
  );
  let active = 0,
    peak = 0;
  globalThis.fetch = async (url) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    const page = Number(new URL(url).searchParams.get('start'));
    return Response.json({
      response: {
        numFound: rows.length,
        docs: rows.slice((page - 1) * 30, page * 30),
      },
    });
  };
  try {
    const first = await readTrendingIndex(options, initial);
    const result = await readTrendingIndex(options, initial + 10000, first);
    assert.equal(result.partial, false);
    assert.equal(result.sampled, rows.length);
    assert.equal(result.before, first.before);
    assert.equal(validTrendingIndex(result), true);
    assert.ok(peak <= 6, 'Upstream concurrency must remain bounded');
    const normalized = rows.map(normalize);
    for (const { value: period } of trendingPeriods)
      for (const minutes of [0, 10, 20, 30]) {
        const selected = { period, minutes };
        const chart = selectTrendingChart(result, selected);
        assert.deepEqual(
          chart.trending.map((s) => s.id),
          rankTrending(normalized, 30, selected, initial).map((s) => s.id),
          `${period}:${minutes}`,
        );
        assert.equal(
          chart.total,
          normalized.filter(
            (s) =>
              (!minutes || (s.duration > 0 && s.duration <= minutes * 60)) &&
              (period === 'all' ||
                (Date.parse(s.uploadedAt) >=
                  Date.parse(trendingWindow(period, initial).after) &&
                  Date.parse(s.uploadedAt) <= initial)),
          ).length,
        );
        assert.equal(chart.index, undefined);
        assert.equal(chart.seen, undefined);
      }
  } finally {
    globalThis.fetch = original;
  }
});

void test('shared indexing retries a failed page on the next pass and retains progress through an outage', async () => {
  const original = globalThis.fetch;
  let failed = false,
    offline = false;
  const pages = [];
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('start'));
    pages.push(page);
    if (offline || (page === 2 && !failed)) {
      failed = true;
      throw new Error('offline');
    }
    return Response.json({
      response: {
        numFound: 1800,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(1800 - (page - 1) * 30 - i),
        ),
      },
    });
  };
  try {
    const first = await readTrendingIndex(options, initial);
    assert.equal(first.sampled, 330);
    assert.deepEqual(first.index.retryPages, [2]);
    const saved = JSON.stringify(first);
    offline = true;
    const paused = await readTrendingIndex(options, initial + 3500, first);
    assert.equal(paused.coverage.status, 'paused');
    assert.equal(paused.sampled, first.sampled);
    assert.ok(paused.index.retryPages.length > first.index.retryPages.length);
    assert.equal(
      JSON.stringify(first),
      saved,
      'A failed pass must not mutate the saved checkpoint',
    );
    offline = false;
    pages.length = 0;
    const next = await readTrendingIndex(options, initial + 70000, first);
    assert.equal(
      pages[1],
      2,
      'Due retries follow head reconciliation and precede the rest of the archive',
    );
    assert.equal(next.sampled, 1380);
    assert.deepEqual(next.index.retryPages, []);
    const done = await readTrendingIndex(options, initial + 74000, next);
    assert.equal(done.partial, false);
    assert.equal(done.sampled, 1800);
  } finally {
    globalThis.fetch = original;
  }
});

void test('duplicate shared pages cannot complete coverage and shrinking libraries reconcile without discarding progress', async () => {
  const original = globalThis.fetch;
  let repeated = true,
    total = 600;
  globalThis.fetch = async (url) => {
    let page = Number(new URL(url).searchParams.get('start'));
    if (repeated && page === 2) page = 1;
    return Response.json({
      response: {
        numFound: total,
        docs: Array.from(
          { length: Math.min(30, Math.max(0, total - (page - 1) * 30)) },
          (_, i) => raw(total - (page - 1) * 30 - i),
        ),
      },
    });
  };
  try {
    const first = await readTrendingIndex(options, initial);
    const next = await readTrendingIndex(options, initial + 3500, first);
    assert.equal(next.sampled, 570);
    assert.equal(next.partial, true);
    repeated = false;
    const done = await readTrendingIndex(options, initial + 7000, next);
    assert.equal(done.partial, false);
    assert.equal(done.sampled, 600);
    total = 300;
    const shrinking = await readTrendingIndex(options, initial + 11000, first);
    assert.equal(shrinking.partial, true);
    assert.ok(shrinking.sampled >= first.sampled);
    assert.equal(shrinking.libraryTotal, 300);
    assert.equal(shrinking.index.audit.sampled, 0);
    assert.equal(validTrendingIndex(shrinking), true);
    const corrupt = structuredClone(first);
    corrupt.seen = 'AAAA';
    await assert.rejects(
      readTrendingIndex(options, initial, corrupt),
      /coverage is invalid/,
    );
    const invalid = structuredClone(done);
    delete invalid.index.charts['month:10'];
    assert.equal(Boolean(validTrendingIndex(invalid)), false);
  } finally {
    globalThis.fetch = original;
  }
});

void test('concurrent periods share one index lease and return their own cohort filters', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 1));
    const page = Number(new URL(url).searchParams.get('start'));
    return Response.json({
      response: {
        numFound: 30,
        docs:
          page === 1 ? Array.from({ length: 30 }, (_, i) => raw(30 - i)) : [],
      },
    });
  };
  try {
    const service = createTrendingService({ now: () => initial });
    const results = await Promise.all(
      trendingPeriods.map(({ value: period }) =>
        service({ period, minutes: 0 }),
      ),
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      results.map((result) => result.period),
      trendingPeriods.map((period) => period.value),
    );
    assert.ok(results.every((result) => !result.partial));
  } finally {
    globalThis.fetch = original;
  }
});

void test('a shared rebuild serves completed rankings and resumes its new cursor across restarts', async () => {
  const original = globalThis.fetch;
  const { db, sqlite } = database();
  let now = initial,
    total = 30;
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('start'));
    return Response.json({
      response: {
        numFound: total,
        docs: Array.from(
          { length: Math.min(30, Math.max(0, total - (page - 1) * 30)) },
          (_, i) => raw(total - (page - 1) * 30 - i),
        ),
      },
    });
  };
  try {
    const config = { database: () => db, now: () => now };
    const first = await createTrendingService(config)({
      period: 'month',
      minutes: 0,
    });
    assert.equal(first.partial, false);
    total = 600;
    now += 12 * 3600000;
    const refreshing = await createTrendingService(config)({
      period: 'year',
      minutes: 10,
    });
    assert.equal(refreshing.refreshing, true);
    assert.equal(refreshing.partial, false);
    assert.equal(refreshing.total, 30);
    assert.equal(refreshing.fetchedAt, first.fetchedAt);
    const saved = JSON.parse(
      sqlite.prepare('SELECT plan FROM search_runs').get().plan,
    );
    assert.equal(saved.snapshot.sampled, 360);
    assert.equal(saved.lastComplete.sampled, 30);
    now += 3500;
    const finished = await createTrendingService(config)({
      period: 'month',
      minutes: 0,
    });
    assert.equal(finished.refreshing, undefined);
    assert.equal(finished.partial, false);
    assert.equal(finished.total, 600);
    assert.notEqual(finished.before, first.before);
  } finally {
    globalThis.fetch = original;
    sqlite.close();
  }
});

void test('a completed chart being rebuilt bypasses CDN caching so polling advances the index', async () => {
  const { GET: rebuilding } = await load('app/api/discover/route.ts', [
    {
      name: 'rebuilding-chart',
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/trending-cache$/ }, () => ({
          path: 'cache',
          namespace: 'mock',
        }));
        build.onResolve({ filter: /^@\/lib\/search-db$/ }, () => ({
          path: 'db',
          namespace: 'mock',
        }));
        build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          contents:
            path === 'db'
              ? 'export const searchDatabase = () => undefined;'
              : `export class TrendingBusyError extends Error {};
           export const createTrendingService = () => async () => (${JSON.stringify({ ...snapshot(), refreshing: true })});`,
        }));
      },
    },
  ]);
  const response = await rebuilding(
    new Request('http://localhost/api/discover?period=week'),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).refreshing, true);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

void test('the 434510/434602 stall reconciles the head instead of looping through known archive offsets', async () => {
  const original = globalThis.fetch;
  const total = 434602;
  let upstreamTotal = 434510;
  const pages = [];
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('start'));
    pages.push(page);
    return Response.json({
      response: {
        numFound: upstreamTotal,
        docs: Array.from(
          {
            length: Math.min(30, Math.max(0, upstreamTotal - (page - 1) * 30)),
          },
          (_, i) => raw(upstreamTotal - (page - 1) * 30 - i),
        ),
      },
    });
  };
  try {
    const first = await readTrendingIndex(options, initial);
    const seen = Buffer.alloc(Math.ceil(total / 8));
    for (let id = 1; id <= 434510; id++) seen[id >>> 3] |= 1 << (id & 7);
    const saved = {
      ...first,
      sampled: 434510,
      libraryTotal: total,
      total,
      seen: seen.toString('base64'),
      nextPage: 9000,
      index: {
        ...first.index,
        charts: Object.fromEntries(
          Object.entries(first.index.charts).map(([key, chart]) => [
            key,
            { ...chart, total: 434510 },
          ]),
        ),
      },
    };
    delete saved.index.audit;
    delete saved.coverage;
    upstreamTotal = total;
    assert.equal(validTrendingIndex(saved), true);
    const result = await readTrendingIndex(options, initial + 3500, saved);
    assert.equal(
      result.sampled,
      total,
      'All 92 missing new recordings must be recovered at the head',
    );
    assert.equal(
      result.partial,
      true,
      'Historical union cardinality alone cannot certify current coverage',
    );
    assert.equal(result.coverage?.guaranteed, false);
    assert.ok(
      pages.slice(12).includes(1),
      'Every resumed pass must reconcile new head records',
    );
  } finally {
    globalThis.fetch = original;
  }
});

void test('changing totals and offset shifts require a fresh census, then recover every ranking', async () => {
  const original = globalThis.fetch;
  const rows = Array.from({ length: 600 }, (_, i) => raw(600 - i));
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('start'));
    return Response.json({
      response: {
        numFound: rows.length,
        start: page,
        docs: rows.slice((page - 1) * 30, page * 30),
      },
    });
  };
  try {
    const first = await readTrendingIndex(options, initial);
    rows.unshift(raw(1000, { shiurvisitsnum: 10000 }));
    const shifted = await readTrendingIndex(options, initial + 3500, first);
    assert.equal(shifted.sampled, 601);
    assert.equal(
      shifted.partial,
      true,
      'A changing-total sweep remains provisional even when its union matches',
    );
    assert.equal(shifted.coverage.status, 'reconciling');
    const recovered = await readTrendingIndex(options, initial + 7000, shifted);
    assert.equal(recovered.partial, false);
    assert.equal(recovered.coverage.status, 'reconciled');
    assert.equal(recovered.coverage.guaranteed, false);
    for (const { value: period } of trendingPeriods)
      for (const minutes of [0, 10, 20, 30])
        assert.deepEqual(
          selectTrendingChart(recovered, { period, minutes }).trending.map(
            (s) => s.id,
          ),
          rankTrending(
            rows.map(normalize),
            30,
            { period, minutes },
            initial,
          ).map((s) => s.id),
        );
  } finally {
    globalThis.fetch = original;
  }
});

void test('same-total replacements cannot pass a historical union audit, and removed winners leave the reconciled chart', async () => {
  const original = globalThis.fetch;
  let rows = Array.from({ length: 600 }, (_, i) => raw(600 - i));
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('start'));
    return Response.json({
      response: {
        numFound: rows.length,
        docs: rows.slice((page - 1) * 30, page * 30),
      },
    });
  };
  try {
    const first = await readTrendingIndex(options, initial);
    rows = [raw(1000, { shiurvisitsnum: 10000 }), ...rows.slice(1)];
    const mixed = await readTrendingIndex(options, initial + 3500, first);
    assert.equal(mixed.sampled, 601);
    assert.equal(mixed.libraryTotal, 600);
    assert.equal(mixed.partial, true);
    assert.equal(validTrendingIndex(mixed), true);
    const recovered = await readTrendingIndex(options, initial + 7000, mixed);
    assert.equal(recovered.partial, false);
    assert.equal(recovered.sampled, 600);
    assert.equal(recovered.trending[0].id, 1000);
    assert.ok(!recovered.index.items.some((s) => s.id === 600));
    assert.equal(recovered.index.charts['all:0'].total, 600);
  } finally {
    globalThis.fetch = original;
  }
});

void test('failed-page retries use persisted backoff, do not starve enumeration, and recover after a server restart', async () => {
  const original = globalThis.fetch;
  const { db, sqlite } = database();
  let now = initial,
    fail = true,
    page2Calls = 0,
    calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const page = Number(new URL(url).searchParams.get('start'));
    if (page === 2) {
      page2Calls++;
      if (fail) return new Response('', { status: 500 });
    }
    return Response.json({
      response: {
        numFound: 2400,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(2400 - (page - 1) * 30 - i),
        ),
      },
    });
  };
  const advance = () =>
    createTrendingService({
      database: () => db,
      now: () => now,
      requireStorage: true,
      reportProgress: true,
    })({ period: 'all', minutes: 0 });
  try {
    let data = await advance();
    assert.equal(data.sampled, 330);
    now += 3500;
    data = await advance();
    assert.equal(page2Calls, 1, 'Not retried during persisted backoff');
    assert.ok(data.sampled > 1000, 'A failed page cannot starve the archive');
    now = initial + 31000;
    data = await advance();
    assert.equal(page2Calls, 2);
    now = initial + 92000;
    data = await advance();
    assert.equal(page2Calls, 3);
    assert.equal(data.partial, true);
    assert.equal(data.coverage.status, 'paused');
    const saved = sqlite.prepare('SELECT plan FROM search_runs').get().plan;
    const beforeCalls = calls;
    now += 1000;
    const held = await advance();
    assert.equal(held.coverage.status, 'paused');
    assert.equal(
      calls,
      beforeCalls,
      'Restarted services make no upstream requests during backoff',
    );
    assert.equal(
      sqlite.prepare('SELECT plan FROM search_runs').get().plan,
      saved,
    );
    fail = false;
    now = data.coverage.retryAt + 1;
    data = await advance();
    assert.equal(data.partial, false);
    assert.equal(data.sampled, 2400);
    assert.equal(page2Calls, 4);
    const completedCalls = calls;
    now += 60000;
    await advance();
    assert.equal(
      calls,
      completedCalls,
      'Fresh census must not trigger a rescan',
    );
  } finally {
    globalThis.fetch = original;
    sqlite.close();
  }
});

void test('missing records, duplicate records within a page, and misplaced responses remain partial until corrected', async () => {
  const original = globalThis.fetch;
  try {
    for (const fault of ['short', 'duplicate', 'offset']) {
      let broken = true;
      globalThis.fetch = async (url) => {
        const page = Number(new URL(url).searchParams.get('start'));
        const docs = Array.from({ length: 30 }, (_, i) =>
          raw(600 - (page - 1) * 30 - i),
        );
        if (broken && page === 2) {
          if (fault === 'short') docs.pop();
          if (fault === 'duplicate') docs[1] = docs[0];
        }
        return Response.json({
          response: {
            numFound: 600,
            start: broken && page === 2 && fault === 'offset' ? 1 : page,
            docs,
          },
        });
      };
      const first = await readTrendingIndex(options, initial);
      assert.equal(first.partial, true, fault);
      assert.deepEqual(first.index.retryPages, [2], fault);
      assert.equal(first.sampled, 330, fault);
      broken = false;
      const recovered = await readTrendingIndex(
        options,
        initial + 31000,
        first,
      );
      assert.equal(recovered.partial, false, fault);
      assert.equal(recovered.sampled, 600, fault);
    }
  } finally {
    globalThis.fetch = original;
  }
});

void test('a stable API that omits a record ends an unproductive full sweep with explicit unresolved coverage', async () => {
  const original = globalThis.fetch;
  const pages = [];
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('start'));
    pages.push(page);
    const effective = page === 2 ? 1 : page;
    return Response.json({
      response: {
        numFound: 600,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(600 - (effective - 1) * 30 - i),
        ),
      },
    });
  };
  try {
    let result = await readTrendingIndex(options, initial);
    result = await readTrendingIndex(options, initial + 3500, result);
    assert.equal(result.sampled, 570);
    result = await readTrendingIndex(options, initial + 7000, result);
    assert.equal(result.sampled, 570);
    assert.equal(result.partial, true);
    assert.equal(result.coverage.status, 'paused');
    assert.match(result.coverage.reason, /could not reconcile/);
    const calls = pages.length;
    assert.equal(
      await readTrendingIndex(options, initial + 11000, result),
      result,
    );
    assert.equal(pages.length, calls);
  } finally {
    globalThis.fetch = original;
  }
});

const { runTrendingWarm } = await load('scripts/trending-runner.ts');
void test('the warmer stops count stalls, honors census cursor progress, bounds failures, and resumes work budgets', async () => {
  const original = globalThis.fetch;
  const config = {
    base: new URL('https://fixture.test'),
    refresh: true,
    token: 'fixture-token',
    minutes: 0,
    periods: ['all'],
    maxPasses: 100,
    sleep: async () => {},
    log: () => {},
  };
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({
        ...snapshot({ period: 'all', minutes: 0 }),
        sampled: 434510,
        libraryTotal: 434602,
        partial: true,
      });
    };
    assert.equal(await runTrendingWarm(config), 'deferred');
    assert.equal(calls, 4);
    const delays = [];
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error('network unavailable');
    };
    assert.equal(
      await runTrendingWarm({
        ...config,
        sleep: async (ms) => delays.push(ms),
      }),
      'deferred',
    );
    assert.equal(calls, 3);
    assert.deepEqual(delays, [30000, 60000]);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({
        ...snapshot({ period: 'all', minutes: 0 }),
        partial: calls < 6,
        coverage: {
          status: calls < 6 ? 'scanning' : 'reconciled',
          guaranteed: false,
          cursor: calls * 36,
          round: 2,
          sweepSampled: calls * 30,
          pendingPages: 0,
          requests: 36,
          added: 0,
        },
      });
    };
    assert.equal(
      await runTrendingWarm(config),
      'reconciled',
      'Known-ID census cursor movement is progress',
    );
    assert.equal(calls, 6);
    let now = initial;
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({
        ...snapshot({ period: 'all', minutes: 0 }),
        partial: true,
      });
    };
    assert.equal(
      await runTrendingWarm({
        ...config,
        maxRuntimeMs: 3000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
      'deferred',
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

void test('an unaudited legacy completed union is retained for display but triggers an independent census once', async () => {
  const original = globalThis.fetch;
  const { db, sqlite } = database();
  let now = initial;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      response: {
        numFound: 30,
        docs: Array.from({ length: 30 }, (_, i) => raw(30 - i)),
      },
    });
  };
  try {
    const legacy = await readTrendingIndex(options, initial);
    delete legacy.coverage;
    const key = 'trending:v1:shared:2';
    sqlite
      .prepare(
        'INSERT INTO search_runs (id,fingerprint,plan,total,next,created,lease) VALUES (?,?,?,?,?,?,0)',
      )
      .run(key, key, JSON.stringify({ snapshot: legacy }), 30, 2, now);
    const saved = await createTrendingService({
      database: () => db,
      now: () => now,
      cachedOnly: true,
    })(options);
    assert.equal(saved.sampled, 30);
    assert.equal(
      calls,
      1,
      'Saved reads retain legacy results without upstream work',
    );
    const audited = await createTrendingService({
      database: () => db,
      now: () => now,
      reportProgress: true,
      requireStorage: true,
    })(options);
    assert.equal(audited.coverage.status, 'reconciled');
    assert.equal(calls, 2, 'A legacy completion cannot skip the first census');
    now += 5000;
    await createTrendingService({
      database: () => db,
      now: () => now,
      reportProgress: true,
    })(options);
    assert.equal(calls, 2, 'The reconciled census remains fresh');
  } finally {
    globalThis.fetch = original;
    sqlite.close();
  }
});

void test('the protected refresh returns active rebuild coverage while public reads retain the last chart', async () => {
  const original = globalThis.fetch;
  const { db, sqlite } = database();
  let now = initial,
    total = 30;
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('start'));
    return Response.json({
      response: {
        numFound: total,
        docs: Array.from(
          { length: Math.min(30, Math.max(0, total - (page - 1) * 30)) },
          (_, i) => raw(total - (page - 1) * 30 - i),
        ),
      },
    });
  };
  try {
    const config = { database: () => db, now: () => now };
    await createTrendingService(config)(options);
    now += 12 * 3600000;
    total = 600;
    const active = await createTrendingService({
      ...config,
      requireStorage: true,
      reportProgress: true,
    })(options);
    assert.equal(active.partial, true);
    assert.equal(active.sampled, 360);
    assert.equal(active.coverage.cursor, 13);
    const display = await createTrendingService({
      ...config,
      cachedOnly: true,
    })(options);
    assert.equal(display.partial, false);
    assert.equal(display.sampled, 30);
    assert.equal(display.refreshing, true);
    assert.equal(display.coverage.cursor, 13);
  } finally {
    globalThis.fetch = original;
    sqlite.close();
  }
});

void test('rolling concurrency starts healthy pages before a slow peer finishes while keeping six connections', async () => {
  const original = globalThis.fetch;
  const events = [];
  let active = 0,
    peak = 0;
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('start'));
    events.push(`start:${page}`);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, page === 13 ? 40 : 1));
    active--;
    events.push(`end:${page}`);
    return Response.json({
      response: {
        numFound: 2400,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(2400 - (page - 1) * 30 - i),
        ),
      },
    });
  };
  try {
    const first = await readTrendingIndex(options, initial);
    events.length = 0;
    await readTrendingIndex(options, initial + 3500, first);
    assert.ok(events.indexOf('start:19') < events.indexOf('end:13'));
    assert.ok(peak <= 6);
  } finally {
    globalThis.fetch = original;
  }
});

void test('the warmer honors long server backoff and paused coverage without sleeping away an Actions job', async () => {
  const original = globalThis.fetch;
  let calls = 0,
    sleeps = 0;
  const config = {
    base: new URL('https://fixture.test'),
    refresh: true,
    token: 'fixture-token',
    minutes: 0,
    periods: ['all'],
    maxPasses: 100,
    log: () => {},
    sleep: async () => {
      sleeps++;
    },
  };
  try {
    globalThis.fetch = async () => {
      calls++;
      return new Response('{}', {
        status: 503,
        headers: { 'Retry-After': '21600' },
      });
    };
    assert.equal(await runTrendingWarm(config), 'deferred');
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({
        ...snapshot({ period: 'all', minutes: 0 }),
        partial: true,
        coverage: {
          status: 'paused',
          guaranteed: false,
          reason: 'Pages missing',
          retryAt: Date.now() + 21600000,
        },
      });
    };
    assert.equal(await runTrendingWarm(config), 'deferred');
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  } finally {
    globalThis.fetch = original;
  }
});

void test('a pass deadline preserves unstarted pages without counting them as repeated upstream failures', async () => {
  const original = globalThis.fetch;
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(
    AbortSignal,
    'timeout',
  );
  const originalTimeout = (ms) =>
    Reflect.apply(timeoutDescriptor.value, AbortSignal, [ms]);
  let controller = new AbortController(),
    interrupt = false,
    calls = 0;
  AbortSignal.timeout = (ms) =>
    ms === 45000 ? controller.signal : originalTimeout(ms);
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('start'));
    calls++;
    if (interrupt && page === 13) controller.abort();
    return Response.json({
      response: {
        numFound: 600,
        docs: Array.from({ length: 30 }, (_, i) =>
          raw(600 - (page - 1) * 30 - i),
        ),
      },
    });
  };
  try {
    const first = await readTrendingIndex(options, initial);
    interrupt = true;
    calls = 0;
    const interrupted = await readTrendingIndex(options, initial + 3500, first);
    assert.equal(interrupted.partial, true);
    assert.equal(interrupted.coverage.status, 'paused');
    assert.ok(interrupted.sampled >= first.sampled);
    assert.ok(interrupted.index.retryPages.length > 0);
    assert.ok(
      Object.values(interrupted.index.retries).every((r) => r.attempts === 0),
    );
    assert.equal(validTrendingIndex(interrupted), true);
    assert.ok(calls < 9, 'The deadline stops new fetches');
    controller = new AbortController();
    interrupt = false;
    const resumed = await readTrendingIndex(
      options,
      initial + 40000,
      interrupted,
    );
    assert.equal(
      resumed.coverage.status,
      'scanning',
      'Due pending pages continue without pausing the runner',
    );
    const recovered = await readTrendingIndex(
      options,
      initial + 44000,
      resumed,
    );
    assert.equal(recovered.partial, false);
    assert.equal(recovered.sampled, 600);
  } finally {
    globalThis.fetch = original;
    Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
  }
});

void test('browser polling honors persisted backoff instead of advancing a paused index every few seconds', async () => {
  const original = globalThis.fetch;
  const retries = [];
  globalThis.fetch = async () =>
    Response.json({
      ...snapshot(options),
      partial: true,
      coverage: {
        status: 'paused',
        guaranteed: false,
        retryAt: Date.now() + 3600000,
      },
    });
  try {
    await loadDiscovery(
      options,
      new AbortController().signal,
      () => {},
      (seconds) => retries.push(seconds),
      false,
    );
    assert.equal(retries.length, 1);
    assert.ok(retries[0] >= 3599 && retries[0] <= 3600);
  } finally {
    globalThis.fetch = original;
  }
});

const { createTrendingLocalCache, trendingLocalKey, preferDiscoveryChart } =
  await load('lib/trending-local.ts');
const { loadSavedDiscovery } = await load('lib/discovery-client.ts');
const localSnapshot = (selected = options, now = initial) => ({
  ...snapshot(selected, now),
  trending: [normalize(raw(42))],
});
function localStorageFixture() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

void test('local daily and weekly charts survive reloads, stay separate by duration, and strip private indexing fields', () => {
  const storage = localStorageFixture();
  const cache = createTrendingLocalCache(() => storage);
  for (const period of ['day', 'week'])
    for (const minutes of [0, 10, 20, 30]) {
      const chart = {
        ...localSnapshot({ period, minutes }),
        seen: 'server-only',
        nextPage: 123,
        nextId: 42,
        index: { secret: true },
      };
      cache.save(chart);
    }
  const restored = createTrendingLocalCache(() => storage).read();
  assert.equal(Object.keys(restored).length, 8);
  for (const period of ['day', 'week'])
    for (const minutes of [0, 10, 20, 30]) {
      const chart = restored[`${period}:${minutes}`];
      assert.equal(chart.period, period);
      assert.equal(chart.minutes, minutes);
      assert.equal(chart.fetchedAt, new Date(initial).toISOString());
      assert.equal(chart.stale, true);
      for (const key of ['seen', 'index', 'nextId', 'nextPage'])
        assert.equal(chart[key], undefined);
    }
});

void test('corrupt or unavailable browser storage cannot hide a valid in-memory chart', () => {
  const storage = localStorageFixture();
  storage.setItem(trendingLocalKey, '{not json');
  assert.deepEqual(createTrendingLocalCache(() => storage).read(), {});
  storage.setItem(
    trendingLocalKey,
    JSON.stringify({
      'week:0': { ...localSnapshot(), trending: [{ id: 42, views: 10 }] },
      'day:0': localSnapshot(),
    }),
  );
  assert.deepEqual(createTrendingLocalCache(() => storage).read(), {});
  const missingCategory = localSnapshot();
  delete missingCategory.trending[0].category;
  storage.setItem(
    trendingLocalKey,
    JSON.stringify({ 'week:0': missingCategory }),
  );
  assert.deepEqual(
    createTrendingLocalCache(() => storage).read(),
    {},
    'Malformed cached metadata must not crash recommendations',
  );
  const blocked = createTrendingLocalCache(() => {
    throw new Error('Storage is blocked');
  });
  blocked.save(localSnapshot());
  assert.equal(blocked.read()['week:0'].trending[0].id, 42);
});

void test('a local chart appears before either network response on daily and weekly Home/Trending loads', async () => {
  const original = globalThis.fetch;
  try {
    for (const period of ['day', 'week']) {
      const selected = { period, minutes: 0 };
      const cache = createTrendingLocalCache(() => localStorageFixture());
      cache.save(localSnapshot(selected));
      let release;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const updates = [];
      globalThis.fetch = async () => (await pending).clone();
      const request = loadDiscovery(
        selected,
        new AbortController().signal,
        (data) => updates.push(data),
        () => {},
        true,
        cache,
      );
      assert.equal(
        updates.length,
        1,
        'Local saved rankings publish synchronously',
      );
      assert.equal(updates[0].trending[0].id, 42);
      assert.equal(updates[0].fetchedAt, new Date(initial).toISOString());
      release(Response.json(localSnapshot(selected, initial + 10000)));
      await request;
      assert.equal(
        updates.at(-1).fetchedAt,
        new Date(initial + 10000).toISOString(),
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

void test('background partial scans cannot replace the last complete local chart or its original timestamp', async () => {
  const original = globalThis.fetch;
  const storage = localStorageFixture();
  const cache = createTrendingLocalCache(() => storage);
  const previous = localSnapshot();
  cache.save(previous);
  const partial = {
    ...localSnapshot(options, initial + 10000),
    partial: true,
    sampled: 20,
    total: 30,
    trending: [normalize(raw(99))],
  };
  try {
    globalThis.fetch = async () => Response.json(partial);
    const updates = [];
    await loadDiscovery(
      options,
      new AbortController().signal,
      (data) => updates.push(data),
      () => {},
      false,
      cache,
    );
    assert.equal(updates.at(-1).trending[0].id, 42);
    assert.equal(updates.at(-1).fetchedAt, previous.fetchedAt);
    assert.equal(updates.at(-1).refreshing, true);
    assert.equal(
      createTrendingLocalCache(() => storage).read()['week:0'].trending[0].id,
      42,
    );
    globalThis.fetch = async () =>
      Response.json({ ...partial, partial: false });
    await loadDiscovery(
      options,
      new AbortController().signal,
      (data) => updates.push(data),
      () => {},
      false,
      cache,
    );
    assert.equal(updates.at(-1).trending[0].id, 99);
  } finally {
    globalThis.fetch = original;
  }
});

void test('saved Home prefetch only reads cached rankings and a failed refresh retains local daily/week charts', async () => {
  const original = globalThis.fetch;
  try {
    for (const period of ['day', 'week']) {
      const selected = { period, minutes: 0 };
      const cache = createTrendingLocalCache(() => localStorageFixture());
      const updates = [];
      globalThis.fetch = async (url) => {
        assert.equal(
          new URL(url, 'http://localhost').searchParams.get('cached'),
          '1',
        );
        return Response.json(localSnapshot(selected));
      };
      await loadSavedDiscovery(
        selected,
        new AbortController().signal,
        (data) => updates.push(data),
        cache,
      );
      assert.equal(cache.read()[`${period}:0`].trending[0].id, 42);
      globalThis.fetch = async () => new Response('', { status: 503 });
      const retries = [];
      await assert.rejects(
        loadDiscovery(
          selected,
          new AbortController().signal,
          (data) => updates.push(data),
          (n) => retries.push(n),
          true,
          cache,
        ),
        /unavailable/,
      );
      assert.equal(updates.at(-1).trending[0].id, 42);
      assert.deepEqual(retries, [30]);
    }
  } finally {
    globalThis.fetch = original;
  }
});

void test('local chart selection never crosses period filters, keeps newer data, and retains a chart across an empty new census', () => {
  const previous = localSnapshot();
  assert.equal(
    preferDiscoveryChart(previous, localSnapshot({ period: 'day', minutes: 0 }))
      .period,
    'day',
  );
  const newer = localSnapshot(options, initial + 10000);
  assert.equal(preferDiscoveryChart(newer, previous), newer);
  const empty = {
    ...localSnapshot(options, initial + 10000),
    partial: true,
    trending: [],
  };
  assert.equal(preferDiscoveryChart(previous, empty).trending[0].id, 42);
});
