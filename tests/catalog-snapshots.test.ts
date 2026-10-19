import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import {
  createPublicSnapshots,
  SnapshotBusyError,
  SnapshotExpiredError,
} from '../lib/public-snapshots';
import { createCatalogService } from '../lib/catalog-service';
import type { SearchDatabase, SearchStatement } from '../lib/search-storage';
import type { CollectionData } from '../lib/catalog';
import { normalize } from '../lib/yutorah';

function database(): SearchDatabase {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  const prepare = (sql: string, values: unknown[] = []): SearchStatement => ({
    bind: (...args) => prepare(sql, args),
    first: async <T>() =>
      (sqlite.prepare(sql).get(...(values as [])) ?? null) as T | null,
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...(values as [])) as T[],
    }),
    run: async () => ({
      meta: {
        changes: Number(sqlite.prepare(sql).run(...(values as [])).changes),
      },
    }),
  });
  return {
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
function collection(): CollectionData {
  return {
    id: 42,
    name: 'A full collection',
    description: '',
    image: 'https://example.test/cover.jpg',
    count: 181,
    updatedAt: '2026-10-17',
    related: [],
    items: Array.from({ length: 181 }, (_, i) =>
      normalize({
        shiurID: i + 1,
        shiurTitle: i === 180 ? 'A unique final lesson' : 'Lesson ' + i,
        shiurDate: new Date(Date.UTC(2020, 0, i + 1)).toISOString(),
      }),
    ),
  };
}
void test('concurrent cold readers share one durable snapshot download', async () => {
  const db = database();
  await createPublicSnapshots({ database: () => db }).save('burst', {
    items: [1, 2],
  });
  let reads = 0;
  const measured: SearchDatabase = {
    ...db,
    prepare(sql) {
      const wrap = (statement: SearchStatement): SearchStatement => ({
        ...statement,
        bind: (...values) => wrap(statement.bind(...values)),
        async first<T>() {
          if (sql.startsWith('SELECT version,payload')) reads++;
          await new Promise((resolve) => setTimeout(resolve, 1));
          return statement.first<T>();
        },
      });
      return wrap(db.prepare(sql));
    },
  };
  const snapshots = createPublicSnapshots({ database: () => measured });
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      snapshots.read('burst', async () => {
        throw new Error('Unexpected upstream read');
      }),
    ),
  );
  assert.equal(
    reads,
    1,
    'A simultaneous burst must download the compressed snapshot once',
  );
  for (const result of results)
    assert.deepEqual(result.value, { items: [1, 2] });
});
void test('snapshot observations distinguish fresh reads, process memory and durable storage', async () => {
  const db = database();
  const first = createPublicSnapshots({ database: () => db });
  const sources: string[] = [];
  const options = { onRead: (source: string) => sources.push(source) };
  await first.read('observed', async () => ({ items: [1] }), options);
  await first.read('observed', async () => ({ items: [2] }), options);
  await createPublicSnapshots({ database: () => db }).read(
    'observed',
    async () => ({ items: [3] }),
    options,
  );
  assert.deepEqual(sources, ['refresh', 'server-memory', 'snapshot']);
});
void test('a fresh process serves small collection pages and global filters from a durable snapshot without upstream reads', async (t) => {
  const db = database();
  const first = createCatalogService({ database: () => db });
  const saved = await first.snapshots.save('collection:42', collection());
  const second = createCatalogService({ database: () => db });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('A warmed collection must not fetch upstream');
  });
  const page = await second.collectionPage(42);
  assert.equal(page.items.length, 60);
  assert.equal(page.count, 181);
  assert.equal(page.next, 60);
  assert.equal(page.lessonIds?.length, 181);
  assert.equal(page.version, saved.version);
  const last = await second.collectionPage(
    42,
    { offset: 180 },
    { version: page.version },
  );
  assert.equal(last.items[0].id, 181);
  assert.equal(last.next, null);
  assert.equal(last.lessonIds, undefined);
  const filter = await second.collectionPage(
    42,
    { query: 'unique' },
    { version: page.version },
  );
  assert.deepEqual(
    filter.items.map((s) => s.id),
    [181],
  );
  assert.equal(filter.total, 1);
  const sorted = await second.collectionPage(
    42,
    { order: 'title' },
    { version: page.version },
  );
  assert.equal(sorted.items[0].id, 181);
  const neighbors = await second.neighbors(42, 180, { version: page.version });
  assert.equal(neighbors.previous?.id, 179);
  assert.equal(neighbors.current?.id, 180);
  assert.equal(neighbors.next?.id, 181);
  assert.equal(neighbors.count, 181);
  assert.equal(neighbors.index, 179);
});
void test('new collection generations do not change pinned pages or lesson neighbors', async () => {
  const db = database();
  const store = createPublicSnapshots({ database: () => db });
  const old = await store.save('collection:42', collection());
  const changed = collection();
  changed.items.reverse();
  changed.items[0].title = 'Changed';
  const current = await store.save('collection:42', changed);
  assert.notEqual(old.version, current.version);
  const other = createPublicSnapshots({ database: () => db });
  assert.equal(
    (
      await other.read('collection:42', async () => changed, {
        version: old.version,
      })
    ).value.items[0].id,
    1,
  );
  assert.equal(
    (await other.peek<CollectionData>('collection:42'))?.version,
    current.version,
  );
  await assert.rejects(
    other.read('collection:42', async () => changed, {
      version: 'f'.repeat(64),
    }),
    SnapshotExpiredError,
  );
});
void test('a stale successful snapshot is returned before background refresh and survives refresh failure', async () => {
  const db = database();
  let now = Date.now();
  const store = createPublicSnapshots({ database: () => db, now: () => now });
  const first = await store.read('home', async () => ({ items: [1] }), {
    ttl: 100,
  });
  now += 101;
  const tasks: (() => Promise<unknown>)[] = [];
  const stale = await store.read(
    'home',
    async () => {
      throw new Error('Upstream outage');
    },
    { ttl: 100, defer: (task) => tasks.push(task) },
  );
  assert.equal(stale.stale, true);
  assert.equal(stale.version, first.version);
  assert.equal(tasks.length, 1);
  await tasks[0]();
  assert.deepEqual((await store.peek('home'))?.value, { items: [1] });
});
void test('same-process cold reads share one upstream request and other hosts cannot take an active lease', async () => {
  const db = database();
  const store = createPublicSnapshots({ database: () => db });
  let release!: () => void;
  const ready = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const read = async () => {
    calls++;
    await ready;
    return { value: 42 };
  };
  const a = store.read('shared', read);
  const b = store.read('shared', read);
  await new Promise<void>((r) => setImmediate(r));
  await assert.rejects(
    createPublicSnapshots({ database: () => db }).read('shared', read),
    SnapshotBusyError,
  );
  release();
  assert.deepEqual((await a).value, (await b).value);
  assert.equal(calls, 1);
});
void test('a refresh that loses its lease cannot publish a generation', async () => {
  const db = database();
  const store = createPublicSnapshots({ database: () => db });
  await assert.rejects(
    store.read('lost', async () => {
      await db
        .prepare(
          "UPDATE catalog_refresh_leases SET owner='other' WHERE resource='lost'",
        )
        .run();
      return { invalid: true };
    }),
    SnapshotBusyError,
  );
  assert.equal(
    await db
      .prepare("SELECT version FROM catalog_snapshots WHERE resource='lost'")
      .first(),
    null,
  );
});
for (const failure of ['lost', 'expired']) {
  void test(`a ${failure} lease cannot prune existing snapshots at capacity`, async () => {
    const db = database();
    const store = createPublicSnapshots({ database: () => db });
    for (let index = 0; index < 256; index++)
      await store.save('retained:' + index, { index });
    await db
      .prepare(
        "INSERT INTO catalog_snapshots(resource,version,payload,bytes,updated,expires) VALUES('expired','old','old',3,0,1)",
      )
      .run();
    const before = await db
      .prepare('SELECT * FROM catalog_snapshots ORDER BY resource,version')
      .all();
    await assert.rejects(
      store.read('rejected', async () => {
        await db
          .prepare(
            failure === 'lost'
              ? "UPDATE catalog_refresh_leases SET owner='successor' WHERE resource='rejected'"
              : "UPDATE catalog_refresh_leases SET expires=1 WHERE resource='rejected'",
          )
          .run();
        return { rejected: true };
      }),
      SnapshotBusyError,
    );
    assert.deepEqual(
      await db
        .prepare('SELECT * FROM catalog_snapshots ORDER BY resource,version')
        .all(),
      before,
      'rejected publication must leave pruning and existing generations untouched',
    );
    if (failure === 'lost')
      assert.equal(
        (
          await db
            .prepare(
              "SELECT owner FROM catalog_refresh_leases WHERE resource='rejected'",
            )
            .first<{ owner: string }>()
        )?.owner,
        'successor',
      );
    await store.save('accepted', { accepted: true });
    assert.equal(
      (
        await db
          .prepare('SELECT COUNT(*) AS count FROM catalog_snapshots')
          .first<{ count: number }>()
      )?.count,
      256,
      'an accepted publication still prunes expired and excess entries',
    );
  });
}
void test('an admitted publication completes atomically even if its lease expires during the transaction', async () => {
  const db = database();
  const store = createPublicSnapshots({
    database: () => ({
      ...db,
      batch: (statements) =>
        db.batch([
          statements[0],
          db.prepare(
            "UPDATE catalog_refresh_leases SET expires=1 WHERE resource='committing'",
          ),
          ...statements.slice(1),
        ]),
    }),
  });
  const saved = await store.save('committing', { committed: true });
  assert.equal(
    (await createPublicSnapshots({ database: () => db }).peek('committing'))
      ?.version,
    saved.version,
  );
  assert.equal(
    await db
      .prepare(
        "SELECT owner FROM catalog_refresh_leases WHERE resource='committing'",
      )
      .first(),
    null,
  );
});
void test('a collection directory contains prepared covers, including confirmed empty images', async () => {
  const db = database();
  const service = createCatalogService({ database: () => db });
  await service.snapshots.save('browse:collection', {
    entries: [
      { id: 1, name: 'One', count: 10 },
      { id: 2, name: 'Two', count: 5 },
    ],
    total: 2,
    next: null,
  });
  await db
    .prepare(
      'INSERT INTO catalog_artwork(id,image,updated) VALUES(1,?,?),(2,?,?)',
    )
    .bind('https://example.test/one.jpg', Date.now(), '', Date.now())
    .run();
  const directory = await service.browse('collection');
  assert.equal(directory.entries[0].image, 'https://example.test/one.jpg');
  assert.equal(directory.entries[0].artworkKnown, true);
  assert.equal(directory.entries[1].image, '');
  assert.equal(directory.entries[1].artworkKnown, true);
});
void test('main search reads series and collections beyond the first browse page from shared snapshots', async (t) => {
  const db = database();
  const service = createCatalogService({ database: () => db });
  await service.snapshots.save('directory', {
    teachers: [],
    topics: [],
    groups: [],
    series: [
      { id: 17, name: 'Weekly Parsha', count: 10, description: '', image: '' },
    ],
  });
  await service.snapshots.save('browse:collection', {
    entries: Array.from({ length: 80 }, (_, i) => ({
      id: i + 1,
      name: i === 79 ? 'Weekly Parsha' : `Other collection ${i}`,
      count: 1,
    })),
    total: 80,
    next: null,
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Warmed suggestions must not fetch upstream');
  });
  const result = await service.suggestions('Weekly Parsha');
  assert.equal(result.partial, false);
  assert.deepEqual(
    result.items.map((item) => [item.kind, item.id]),
    [
      ['collection', 80],
      ['series', 17],
    ],
  );
});
void test('collection suggestions remain usable when teacher and series directories are unavailable', async (t) => {
  const db = database();
  const service = createCatalogService({ database: () => db });
  await service.snapshots.save('browse:collection', {
    entries: [{ id: 42, name: 'Weekly Parsha', count: 5 }],
    total: 1,
    next: null,
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Directory unavailable');
  });
  const result = await service.suggestions('Weekly Parsha');
  assert.equal(result.partial, true);
  assert.equal(result.items[0].kind, 'collection');
});
void test('a slow directory does not block ready collection suggestions and finishes warming in the request lifecycle', async (t) => {
  const db = database();
  const service = createCatalogService({ database: () => db });
  await service.snapshots.save('browse:collection', {
    entries: [{ id: 42, name: 'Weekly Parsha', count: 5 }],
    total: 1,
    next: null,
  });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    await ready;
    return Response.json([]);
  });
  const tasks: (() => Promise<unknown>)[] = [];
  try {
    const result = await service.suggestions('Weekly Parsha', {
      timeoutMs: 20,
      defer: (task) => tasks.push(task),
    });
    assert.equal(result.partial, true);
    assert.equal(result.items[0].kind, 'collection');
    assert.equal(tasks.length, 1);
  } finally {
    release();
    await Promise.all(tasks.map((task) => task()));
  }
});
void test('submitted catalog search paginates all matching pages and includes venues without upstream reads', async (t) => {
  const db = database();
  const service = createCatalogService({ database: () => db });
  await service.snapshots.save('directory', {
    teachers: [],
    topics: [],
    groups: [],
    series: [],
  });
  await service.snapshots.save('browse:collection', {
    entries: Array.from({ length: 80 }, (_, id) => ({
      id: id + 1,
      name: 'Weekly Parsha',
      count: 1,
    })),
    total: 80,
    next: null,
  });
  await service.snapshots.save('browse:venue', {
    entries: [{ id: 200, name: 'Weekly Parsha', count: 100 }],
    total: 1,
    next: null,
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Use the warmed snapshots');
  });
  const first = await service.search('Weekly Parsha');
  assert.equal(first.total, 81);
  assert.equal(first.items.length, 60);
  assert.equal(first.next, 60);
  assert.equal(first.items[0].kind, 'venue');
  const last = await service.search('Weekly Parsha', first.next!);
  assert.equal(last.items.length, 21);
  assert.equal(last.next, null);
  assert.equal(
    new Set(
      [...first.items, ...last.items].map((item) => `${item.kind}-${item.id}`),
    ).size,
    81,
  );
  assert.equal(first.partial, false);
  await assert.rejects(service.search('x'.repeat(301)), RangeError);
  await assert.rejects(service.search('query', -1), RangeError);
});
void test('cache storage outages keep public reads usable without claiming a durable write', async () => {
  for (const table of ['catalog_snapshots', 'catalog_refresh_leases']) {
    const db = database();
    await db.prepare('DROP TABLE ' + table).run();
    const store = createPublicSnapshots({ database: () => db });
    let reads = 0;
    const source = async () => {
      reads++;
      return { items: [1, 2] };
    };
    assert.deepEqual((await store.read('home', source)).value.items, [1, 2]);
    assert.deepEqual((await store.read('home', source)).value.items, [1, 2]);
    assert.equal(reads, 1);
  }
  const db = database();
  const store = createPublicSnapshots({
    database: () => ({
      ...db,
      batch: async () => {
        throw new Error('Storage outage');
      },
    }),
  });
  const saved = await store.save('home', { items: [3] });
  assert.deepEqual((await store.peek('home'))?.value, { items: [3] });
  assert.equal(
    await db
      .prepare('SELECT resource FROM catalog_snapshots WHERE version=?')
      .bind(saved.version)
      .first(),
    null,
  );
});
