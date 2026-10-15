import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { SearchDatabase, SearchStatement } from '../lib/search-storage';
import {
  postgresSearchDatabase,
  postgresSearchPool,
} from '../lib/search-postgres';
import { packNote, type SavedNote } from '../lib/tidb-notes-store';
import {
  syncNotesPage,
  cleanNotesIndex,
  noteSearchDocument,
  type NotesIndexSource,
} from '../lib/notes-search-index';
import {
  notesSnapshot,
  searchNotes,
  notesSearchQuery,
  NotesSearchError,
  NOTES_SNAPSHOT_LIFETIME,
} from '../lib/notes-search';
import { completeSearch } from '../lib/complete-search';
import { normalize } from '../lib/yutorah';
import { noFilters, resolvedSearchFilters } from '../lib/search-filters';
import {
  encodeSearchDocument,
  decodeSearchDocument,
} from '../lib/notes-search-document';
import { notesSyncOptions } from '../scripts/sync-notes-search';
import { migrateNotesSearchSchema } from '../scripts/migrate-search-schema';

function sqliteDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync('drizzle')
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
  function statement(
    sql: string,
    params: (string | number | null)[] = [],
  ): SearchStatement {
    return {
      bind: (...values) => statement(sql, values as typeof params),
      first: async <T>() =>
        (sqlite.prepare(sql).get(...params) ?? null) as T | null,
      all: async <T>() => ({
        results: sqlite.prepare(sql).all(...params) as T[],
      }),
      run: async () => ({
        meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) },
      }),
    };
  }
  const db: SearchDatabase = {
    prepare: statement,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const item of statements) result.push(await item.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, sqlite };
}
const metadata = async (id: string) =>
  normalize({
    shiurid: Number(id),
    shiurtitle: 'discoveryfixture ' + id,
    teacherfullname: 'Fixture teacher',
    duration: 600,
    language: 'EN',
  });
async function note(
  id: number,
  markdown = 'A complete teaching about teshuva and prayer. שָׁלוֹם תשובה',
) {
  return packNote({
    shiurId: String(id),
    markdown,
    sourceHash: 'a'.repeat(64),
    generatorVersion: 'test',
    language: 'EnglishHebrew',
  });
}
function source(initial: SavedNote[]) {
  const rows = new Map(initial.map((row) => [row.shiurId, row]));
  let reads = 0;
  const store: NotesIndexSource = {
    headersAfter: async (after, limit) =>
      [...rows.values()]
        .filter((row) => Number(row.shiurId) > after)
        .sort((a, b) => Number(a.shiurId) - Number(b.shiurId))
        .slice(0, limit)
        .map((row) => ({ id: row.shiurId, hash: row.notesHash })),
    get: async (id) => {
      reads++;
      return rows.get(id) ?? null;
    },
  };
  return { rows, store, reads: () => reads };
}
async function fill(db: SearchDatabase, store: NotesIndexSource, batch = 10) {
  for (let i = 0; i < 100; i++) {
    const progress = await syncNotesPage(db, store, metadata, { batch });
    assert.equal(progress.busy, false);
    if (progress.complete) return progress.snapshot!;
  }
  throw new Error('The fixture did not complete its inventory.');
}

void test('notes queries normalize English/Hebrew, bind SQL and reject empty or excessive input', () => {
  assert.deepEqual(notesSearchQuery('שָׁלוֹם Teshuva', 'terms'), {
    sqlite: '"שלום" AND "teshuva"',
    postgres: "'שלום' & 'teshuva'",
  });
  assert.equal(
    notesSearchQuery('prayer and teshuva', 'phrase').sqlite,
    '"prayer and teshuva"',
  );
  assert.equal(
    notesSearchQuery("don't; ' OR 1=1 --", 'terms').postgres,
    "'dont' & 'or' & '1' & '1'",
  );
  for (const query of [
    '',
    '***',
    'a'.repeat(201),
    Array(17).fill('word').join(' '),
    'a'.repeat(65),
  ])
    assert.throws(() => notesSearchQuery(query, 'terms'), RangeError);
  assert.equal(
    resolvedSearchFilters({ ...normalizePlan(), notesOnly: true }).notesOnly,
    '1',
  );
  assert.equal(noFilters.notesOnly, '');
});
function normalizePlan() {
  return {
    term: '',
    original: '',
    max: 0,
    language: '',
    format: '',
    teacherId: 0,
    teacherName: '',
    seriesId: 0,
    seriesName: '',
    topicId: 0,
    labels: [],
  };
}

async function discoveryContract(db: SearchDatabase) {
  const long = await note(
    1,
    '# A teaching\n\n' +
      'Introduction. '.repeat(80) +
      '\n\nPrayer and teshuva are connected. שָׁלוֹם תשובה',
  );
  const other = await note(
    2,
    'Teshuva requires careful thought. A later discussion concerns prayer.',
  );
  const initial = source([long, other]);
  await assert.rejects(
    searchNotes(db, 'prayer'),
    (error) => error instanceof NotesSearchError && error.status === 503,
  );
  const page = await syncNotesPage(db, initial.store, metadata, { batch: 1 });
  assert.equal(page.complete, false);
  await assert.rejects(
    notesSnapshot(db),
    NotesSearchError,
    'An incomplete first scan must stay private',
  );
  const firstSnapshot = await fill(db, initial.store, 1);
  // A prior release's plain excerpt can coexist with compressed new documents.
  await db
    .prepare('UPDATE search_note_documents SET payload=?,text=? WHERE id=?')
    .bind(
      JSON.stringify(await metadata('2')),
      'Prayer, teshuva and kindness.',
      2,
    )
    .run();
  const terms = await searchNotes(db, 'prayer teshuva');
  assert.equal(terms.total, 2);
  assert.equal(terms.items.length, 2);
  const hit = terms.items.find((item) => item.shiur.id === 1)!;
  assert.match(hit.excerpt, /Prayer and teshuva/);
  assert.ok(hit.excerpt.length <= 282);
  assert.equal(hit.href, '/?shiur=1');
  assert.equal(
    (await searchNotes(db, 'prayer and teshuva', { mode: 'phrase' })).total,
    1,
  );
  assert.equal(
    (await searchNotes(db, 'שלום תשובה', { mode: 'phrase' })).total,
    1,
  );
  assert.equal((await searchNotes(db, 'noexistingword')).total, 0);
  assert.equal((await searchNotes(db, 'prayer', { page: 10 })).items.length, 0);
  assert.equal((await searchNotes(db, 'prayer', { page: 10 })).total, 2);
  await assert.rejects(searchNotes(db, 'prayer', { page: 0 }), RangeError);

  const reads = initial.reads();
  await fill(db, initial.store);
  assert.equal(
    initial.reads(),
    reads,
    'Unchanged hashes must not download and decompress notes again',
  );
  initial.rows.set(
    '1',
    await note(1, 'A fresh replacement discusses kashrus.'),
  );
  initial.rows.delete('2');
  await syncNotesPage(db, initial.store, metadata, { batch: 1 });
  assert.equal(
    (await searchNotes(db, 'prayer')).total,
    2,
    'The ready inventory remains available while building its successor',
  );
  const freshSnapshot = await fill(db, initial.store, 1);
  assert.notEqual(firstSnapshot, freshSnapshot);
  assert.equal(
    (await searchNotes(db, 'prayer')).total,
    0,
    'Replacements and deleted source notes leave the new inventory',
  );
  assert.equal((await searchNotes(db, 'kashrus')).total, 1);
  assert.equal(
    (await searchNotes(db, 'prayer', { snapshot: firstSnapshot })).total,
    2,
    'A paginated search retains the original inventory',
  );
  await db
    .prepare('UPDATE search_note_snapshots SET completed=? WHERE id<>?')
    .bind(Date.now() - NOTES_SNAPSHOT_LIFETIME - 1000, freshSnapshot)
    .run();
  await cleanNotesIndex(db);
  assert.equal((await searchNotes(db, 'kashrus')).total, 1);
  await assert.rejects(
    searchNotes(db, 'prayer', { snapshot: firstSnapshot }),
    (error) => error instanceof NotesSearchError && error.status === 409,
  );
  if (db.dialect !== 'postgres') {
    await db.prepare('VACUUM').run();
    assert.equal(
      (await searchNotes(db, 'kashrus')).total,
      1,
      'External-content FTS keeps stable row identities during SQLite maintenance',
    );
  }
  assert.equal(
    (await db
      .prepare('SELECT COUNT(*) AS n FROM search_note_documents')
      .first<{ n: number }>())!.n,
    1,
  );
  initial.rows.clear();
  await fill(db, initial.store);
  assert.equal(
    (await notesSnapshot(db)).count,
    0,
    'A complete empty source publishes a genuine empty inventory',
  );
}

void test('SQLite FTS searches complete notes and preserves ready inventories through resumable refreshes', async (t) => {
  const { db, sqlite } = sqliteDatabase();
  t.after(() => sqlite.close());
  await migrateNotesSearchSchema(db);
  await migrateNotesSearchSchema(db);
  await discoveryContract(db);
});

void test('staged full-text documents cannot reorder an existing inventory across pages', async (t) => {
  const { db, sqlite } = sqliteDatabase();
  t.after(() => sqlite.close());
  const data = source(
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        note(
          i + 1,
          i % 2
            ? 'prayer '.repeat(8) + 'teshuva'
            : 'prayer ' + 'teshuva '.repeat(8),
        ),
      ),
    ),
  );
  const snapshot = await fill(db, data.store, 20);
  const first = await searchNotes(db, 'prayer teshuva', { snapshot });
  for (let i = 21; i <= 60; i++)
    data.rows.set(String(i), await note(i, 'prayer '.repeat(30)));
  await syncNotesPage(db, data.store, metadata, { batch: 20 });
  await syncNotesPage(db, data.store, metadata, { batch: 20 });
  const second = await searchNotes(db, 'prayer teshuva', { snapshot, page: 2 });
  assert.equal(first.total, 20);
  assert.equal(second.total, 20);
  assert.equal(
    new Set([...first.items, ...second.items].map((hit) => hit.shiur.id)).size,
    20,
  );
});

void test('failed pages, changed source hashes and corrupt notes never publish partial discoveries', async (t) => {
  const { db, sqlite } = sqliteDatabase();
  t.after(() => sqlite.close());
  const saved = await note(3);
  const data = source([saved]);
  const broken: NotesIndexSource = {
    ...data.store,
    get: async () => {
      throw new Error('Source unavailable');
    },
  };
  await assert.rejects(
    syncNotesPage(db, broken, metadata),
    /Source unavailable/,
  );
  assert.equal(
    (await db
      .prepare("SELECT cursor FROM search_notes_state WHERE name='sync'")
      .first<{ cursor: number }>())!.cursor,
    0,
  );
  assert.equal(
    (await db
      .prepare('SELECT COUNT(*) AS n FROM search_note_documents')
      .first<{ n: number }>())!.n,
    0,
  );
  await assert.rejects(
    syncNotesPage(
      db,
      {
        ...data.store,
        get: async () => ({ ...saved, notesHash: 'b'.repeat(64) }),
      },
      metadata,
    ),
    /changed during/,
  );
  await assert.rejects(
    syncNotesPage(
      db,
      {
        ...data.store,
        get: async () => ({ ...saved, gzip: new Uint8Array([1, 2, 3]) }),
      },
      metadata,
    ),
  );
  await fill(db, data.store);
  assert.equal((await searchNotes(db, 'prayer')).total, 1);
  await assert.rejects(
    noteSearchDocument(saved, await metadata('4')),
    /does not match/,
  );
});

void test('D1 upgrade rebuilds text indexed before interrupted trigger installation', async (t) => {
  const { db, sqlite } = sqliteDatabase();
  t.after(() => sqlite.close());
  sqlite.exec('DROP TRIGGER search_note_fulltext_insert');
  const data = source([await note(7, 'A recovered index mentions havdalah.')]);
  await fill(db, data.store);
  assert.equal((await searchNotes(db, 'havdalah')).total, 0);
  await migrateNotesSearchSchema(db);
  assert.equal((await searchNotes(db, 'havdalah')).total, 1);
});

void test('an occupied index lease does no source work, and retired inventories stay bounded', async (t) => {
  const { db, sqlite } = sqliteDatabase();
  t.after(() => sqlite.close());
  const data = source([await note(8)]);
  await syncNotesPage(db, data.store, metadata);
  await db
    .prepare(
      "UPDATE search_notes_state SET owner='peer',lease=? WHERE name='sync'",
    )
    .bind(Date.now() + 30_000)
    .run();
  const progress = await syncNotesPage(
    db,
    {
      ...data.store,
      headersAfter: async () => {
        throw new Error('Must not read the source');
      },
    },
    metadata,
  );
  assert.equal(progress.busy, true);
  await db
    .prepare("UPDATE search_notes_state SET lease=0 WHERE name='sync'")
    .run();
  for (let i = 0; i < 5; i++) await fill(db, data.store);
  await cleanNotesIndex(db);
  assert.ok(
    (await db
      .prepare('SELECT COUNT(*) AS n FROM search_note_snapshots')
      .first<{ n: number }>())!.n <= 2,
  );
  assert.equal((await searchNotes(db, 'prayer')).total, 1);
});

void test('expired and replaced notes-sync leases cannot advance a checkpoint or expose staged documents', async (t) => {
  for (const mode of ['expired', 'replaced', 'database-expired']) {
    const { db, sqlite } = sqliteDatabase();
    t.after(() => sqlite.close());
    const saved = await note(4);
    const data = source([saved]);
    let clock = Date.now();
    const input: NotesIndexSource = {
      ...data.store,
      get: async (id) => {
        if (mode === 'expired') clock += 180_001;
        else if (mode === 'database-expired')
          sqlite.function('julianday', (value: unknown) => {
            assert.equal(value, 'now');
            return (clock + 181_000) / 86_400_000 + 2440587.5;
          });
        else
          await db
            .prepare(
              "UPDATE search_notes_state SET owner='peer',lease=? WHERE name='sync'",
            )
            .bind(clock + 300_000)
            .run();
        return data.store.get(id);
      },
    };
    await assert.rejects(
      syncNotesPage(db, input, metadata, { clock: () => clock }),
      /notes_sync_owned|CHECK constraint failed/,
      mode,
    );
    assert.equal(
      (await db
        .prepare('SELECT COUNT(*) AS n FROM search_note_documents')
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(
      (await db
        .prepare("SELECT cursor FROM search_notes_state WHERE name='sync'")
        .first<{ cursor: number }>())!.cursor,
      0,
    );
    await db
      .prepare("UPDATE search_notes_state SET lease=0 WHERE name='sync'")
      .run();
    if (mode === 'database-expired')
      sqlite.function('julianday', (value: unknown) => {
        assert.equal(value, 'now');
        return Date.now() / 86_400_000 + 2440587.5;
      });
    await fill(db, data.store);
    assert.equal((await searchNotes(db, 'prayer')).total, 1);
  }
});

async function metadataFilterContract(db: SearchDatabase, t: TestContext) {
  const initial = source(
    await Promise.all(Array.from({ length: 45 }, (_, i) => note(i + 16))),
  );
  await fill(db, initial.store);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.includes('/browse/')) return Response.json([]);
    const page = Number(url.searchParams.get('start') || 1);
    return Response.json({
      response: {
        numFound: 60,
        docs: Array.from({ length: 30 }, (_, i) => {
          const id = (page - 1) * 30 + i + 1;
          return {
            shiurid: id,
            shiurtitle: 'discoveryfixture ' + id,
            teacherfullname: 'Fixture teacher',
            duration: 600,
          };
        }),
      },
    });
  });
  const first = await completeSearch(db, 'discoveryfixture', {
    notesOnly: true,
  });
  assert.equal(first.complete, true);
  assert.equal(first.total, 45);
  assert.equal(first.items.length, 30);
  assert.ok(first.items.every((shiur) => shiur.id >= 16));
  const second = await completeSearch(
    db,
    'discoveryfixture',
    { notesOnly: true, notesSnapshot: first.notesSnapshot },
    2,
    first.run,
  );
  assert.equal(second.total, 45);
  assert.equal(second.items.length, 15);
  assert.equal(
    new Set([...first.items, ...second.items].map((shiur) => shiur.id)).size,
    45,
  );
  assert.ok(
    first.items.some((shiur) => shiur.id >= 31),
    'Filtering must include matches from the last upstream page',
  );
  const unfiltered = await completeSearch(
    db,
    'discoveryfixture',
    {},
    1,
    first.run,
  );
  assert.equal(unfiltered.total, 60);
  assert.equal(
    unfiltered.run,
    first.run,
    'Availability reuses the same exhaustive candidate scan',
  );
  initial.rows.set('1', await note(1));
  await fill(db, initial.store);
  assert.equal(
    (
      await completeSearch(
        db,
        'discoveryfixture',
        { notesOnly: true },
        1,
        first.run,
      )
    ).total,
    46,
  );
  assert.equal(
    (
      await completeSearch(
        db,
        'discoveryfixture',
        { notesOnly: true, notesSnapshot: first.notesSnapshot },
        2,
        first.run,
      )
    ).total,
    45,
  );
}
void test('available-notes filtering applies before counts, global pagination and candidate-cache reuse', async (t) => {
  const { db, sqlite } = sqliteDatabase();
  t.after(() => sqlite.close());
  await metadataFilterContract(db, t);
});

void test(
  'PostgreSQL GIN retrieval and the metadata availability filter obey the same contracts',
  {
    skip: !process.env.TEST_DATABASE_URL && !process.env.CI,
  },
  async (t) => {
    assert.ok(
      process.env.TEST_DATABASE_URL,
      'Set TEST_DATABASE_URL to a disposable PostgreSQL database.',
    );
    const schema = 'notes_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
    });
    const pool = postgresSearchPool(process.env.TEST_DATABASE_URL);
    const readerRole = 'notes_reader_' + randomUUID().replaceAll('-', '');
    let reader: Pool | undefined;
    let createdRole = false;
    try {
      for (const file of readdirSync('db/search-postgres')
        .filter((file) => file.endsWith('.sql'))
        .sort())
        await admin.query(
          readFileSync('db/search-postgres/' + file, 'utf8').replaceAll(
            'yutorah_search',
            schema,
          ),
        );
      const db = postgresSearchDatabase(pool, schema);
      await discoveryContract(db);
      await metadataFilterContract(db, t);
      await admin.query('SET enable_seqscan=off');
      const plan = await admin.query(
        `EXPLAIN SELECT key FROM ${schema}.search_note_documents WHERE to_tsvector('simple',normalized) @@ to_tsquery('simple','prayer')`,
      );
      assert.match(
        plan.rows.map((row) => row['QUERY PLAN']).join('\n'),
        /search_note_fulltext/,
      );
      await admin.query(`CREATE ROLE ${readerRole}; GRANT USAGE ON SCHEMA ${schema} TO ${readerRole};
        GRANT SELECT ON ${schema}.search_note_snapshots,${schema}.search_note_members,${schema}.search_note_documents,${schema}.search_notes_state TO ${readerRole}`);
      createdRole = true;
      reader = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c role=${readerRole}`,
      });
      assert.equal(
        (await searchNotes(postgresSearchDatabase(reader, schema), 'prayer'))
          .total,
        46,
      );
      await assert.rejects(
        reader.query(`DELETE FROM ${schema}.search_note_documents`),
        /permission denied/,
      );
    } finally {
      await reader?.end();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (createdRole) await admin.query(`DROP ROLE ${readerRole}`);
      await admin.end();
    }
  },
);

void test('scheduled notes indexing bounds work and exposes a read-only preflight', () => {
  assert.deepEqual(
    notesSyncOptions([
      '--check',
      '--batch',
      '20',
      '--max-pages',
      '500',
      '--max-minutes',
      '10',
    ]),
    { batch: 20, maxPages: 500, maxMinutes: 10, follow: false, check: true },
  );
  for (const args of [
    ['--batch', '21'],
    ['--batch', '0'],
    ['--max-pages', '1001'],
    ['--max-pages', '1.5'],
    ['--max-minutes', '21'],
    ['--max-minutes', 'NaN'],
    ['--max-pages'],
    ['--unknown'],
  ])
    assert.throws(() => notesSyncOptions(args));
});

void test('compressed excerpts preserve Unicode, legacy inventories and decompression bounds', async () => {
  const shiur = JSON.parse(JSON.stringify(await metadata('7')));
  const text = 'שָׁלוֹם. Prayer and teshuva.\n'.repeat(1000);
  const encoded = await encodeSearchDocument(shiur, text);
  assert.ok(encoded.text.length < Buffer.byteLength(text) / 2);
  assert.deepEqual(await decodeSearchDocument(encoded.payload, encoded.text), {
    shiur,
    text,
  });
  assert.deepEqual(await decodeSearchDocument(JSON.stringify(shiur), text), {
    shiur,
    text,
  });
  await assert.rejects(decodeSearchDocument(encoded.payload, 'not base64!'));
  await assert.rejects(
    decodeSearchDocument(
      JSON.stringify({ encoding: 'unknown', shiur }),
      encoded.text,
    ),
  );
  await assert.rejects(
    encodeSearchDocument(shiur, 'a'.repeat(1024 * 1024 + 1)),
  );
  const oversized = await new Response(
    new Blob(['a'.repeat(1024 * 1024 + 1)])
      .stream()
      .pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  await assert.rejects(
    decodeSearchDocument(
      encoded.payload,
      Buffer.from(oversized).toString('base64'),
    ),
    /byte limit/,
  );
});
