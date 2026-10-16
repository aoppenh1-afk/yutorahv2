import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { SearchDatabase, SearchStatement } from '../lib/search-storage';
import {
  runSourcePreparation,
  preparationCatalog,
  preparationFetch,
} from '../lib/source-preparation';
import { advanceSourceCreator } from '../lib/source-creator';
import { pruneSourceCache } from '../lib/sources-cache';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('drizzle/0005_sources.sql', 'utf8'));
  const prepare = (sql: string, params: unknown[] = []): SearchStatement => ({
    bind: (...args) => prepare(sql, args),
    first: async <T>() =>
      (sqlite.prepare(sql).get(...(params as never[])) as T) || null,
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...(params as never[])) as T[],
    }),
    run: async () => ({
      meta: {
        changes: Number(
          sqlite.prepare(sql).run(...(params as never[])).changes,
        ),
      },
    }),
  });
  const db: SearchDatabase = {
    prepare,
    batch: async (statements) =>
      Promise.all(statements.map((statement) => statement.run())),
  };
  return { sqlite, db };
}
function service() {
  const calls: string[] = [];
  let notes = '';
  let transcript = 'The teacher explains the subject.';
  let missing = false;
  const fetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/api/source-creator/features')
      return Response.json({ links: true, sheets: true });
    if (parsed.pathname === '/api/transcript')
      return missing
        ? Response.json({}, { status: 404 })
        : Response.json({
            transcriptId: 'official-' + parsed.searchParams.get('id'),
            segments: [{ text: transcript, startMs: 0, endMs: 1000 }],
          });
    if (parsed.pathname === '/api/shiur/details')
      return Response.json({
        shiurID: Number(parsed.searchParams.get('shiurID')),
        shiurDescription: '',
      });
    if (parsed.pathname === '/api/study-notes')
      return Response.json(
        notes
          ? { status: 'completed', markdown: notes, notesHash: notes }
          : { status: 'missing', markdown: null },
      );
    if (parsed.pathname === '/api/search/get') {
      const page = Number(parsed.searchParams.get('start'));
      return Response.json({
        response: {
          numFound: 90,
          docs: Array.from({ length: 30 }, (_, i) => ({
            shiurID: page * 100 + i + 1,
          })),
        },
      });
    }
    if (parsed.pathname === '/api/find-refs')
      return Response.json({
        body: { results: [], refData: {}, debugData: [] },
      });
    throw new Error('Unexpected endpoint ' + parsed.pathname);
  };
  return {
    fetcher,
    calls,
    setNotes: (value: string) => {
      notes = value;
    },
    setTranscript: (value: string) => {
      transcript = value;
    },
    setMissing: () => {
      missing = true;
    },
  };
}
const options = (db: SearchDatabase, fetcher: typeof fetch) => ({
  db,
  fetcher,
  site: new URL('https://website.test'),
  signal: new AbortController().signal,
  catalogPages: 0,
  maxJobs: 1,
  maxRuntimeMs: 1000,
  wait: async () => {},
});

void test('runner executes the detector locally and the website reuses its prepared result', async () => {
  const { db } = database(),
    api = service();
  const first = await runSourcePreparation({
    ...options(db, api.fetcher),
    ids: ['42'],
  });
  assert.equal(first.ready, 1);
  assert.ok(api.calls.some((url) => url.includes('/api/find-refs')));
  assert.ok(
    !api.calls.some((url) => new URL(url).pathname === '/api/source-creator'),
  );
  const result = await advanceSourceCreator(
    db,
    {
      shiurId: '42',
      transcript: {
        transcriptId: 'official-42',
        segments: [
          {
            text: 'The teacher explains the subject.',
            startMs: 0,
            endMs: 1000,
          },
        ],
      },
    },
    async () => {
      throw new Error('A saved result must not call Sefaria');
    },
  );
  assert.equal(result.status, 'ready');
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS count FROM sources_runs WHERE id LIKE 'prepared:%'",
        )
        .first<{ count: number }>()
    )?.count,
    1,
  );
});

void test('later generated notes and transcript corrections invalidate previously prepared sheets', async () => {
  const { db } = database(),
    api = service();
  const config = options(db, api.fetcher);
  await runSourcePreparation({ ...config, ids: ['42'] });
  const previous = await db
    .prepare("SELECT payload FROM sources_runs WHERE id LIKE 'prepared:%'")
    .first<{ payload: string }>();
  api.setNotes('New notes on the shiur');
  await runSourcePreparation({ ...config, ids: ['42'] });
  const revised = await db
    .prepare("SELECT payload FROM sources_runs WHERE id LIKE 'prepared:%'")
    .first<{ payload: string }>();
  assert.notEqual(
    JSON.parse(previous!.payload).inputVersion,
    JSON.parse(revised!.payload).inputVersion,
  );
  api.setTranscript('A corrected transcript');
  await runSourcePreparation({ ...config, ids: ['42'] });
  const corrected = await db
    .prepare("SELECT payload FROM sources_runs WHERE id LIKE 'prepared:%'")
    .first<{ payload: string }>();
  assert.notEqual(
    JSON.parse(revised!.payload).inputVersion,
    JSON.parse(corrected!.payload).inputVersion,
  );
});

void test('missing inputs retry on schedule and fresh runs reuse the durable backlog', async () => {
  const { db } = database(),
    api = service();
  api.setMissing();
  let now = Date.now();
  const config = { ...options(db, api.fetcher), now: () => now };
  const first = await runSourcePreparation({ ...config, ids: ['42', '43'] });
  assert.equal(first.missing, 1);
  const second = await runSourcePreparation(config);
  assert.equal(second.missing, 1);
  const third = await runSourcePreparation(config);
  assert.equal(third.processed, 0);
  now += 86400_001;
  const fourth = await runSourcePreparation(config);
  assert.equal(fourth.missing, 1);
});

void test('upstream failure stays retryable and never becomes an empty completed sheet', async () => {
  const { db } = database(),
    api = service();
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/api/transcript') || url.includes('/api/study-notes'))
      return Response.json({}, { status: 503 });
    return api.fetcher(input, init);
  };
  const result = await runSourcePreparation({
    ...options(db, fetcher),
    ids: ['42'],
  });
  assert.equal(result.outcome, 'upstream-unavailable');
  assert.equal(result.ready, 0);
  assert.equal(result.deferred, 1);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS count FROM sources_runs WHERE id LIKE 'prepared:%'",
        )
        .first<{ count: number }>()
    )?.count,
    0,
  );
});

void test('archive discovery cannot starve scheduled checks for later notes', async () => {
  const { db } = database(),
    api = service();
  let now = Date.now();
  const config = { ...options(db, api.fetcher), now: () => now };
  await runSourcePreparation({ ...config, ids: ['42'] });
  now += 6 * 3600_000 + 1;
  api.setNotes('Notes published after the first preparation');
  const attempted: string[] = [];
  await runSourcePreparation({
    ...config,
    ids: ['51', '52', '53', '54', '55'],
    maxJobs: 4,
    report: (event) => {
      if (event.id) attempted.push(event.id);
    },
  });
  assert.deepEqual(attempted, ['51', '52', '53', '42']);
});

void test('discovery refreshes latest uploads and advances an independent resumable archive cursor', async () => {
  const { db } = database(),
    api = service();
  const config = { ...options(db, api.fetcher), catalogPages: 2 };
  await runSourcePreparation(config);
  const first = api.calls
    .filter((url) => url.includes('/api/search/get'))
    .map((url) => new URL(url).searchParams.get('start'));
  assert.deepEqual(first, ['1', '2']);
  api.calls.length = 0;
  await runSourcePreparation(config);
  const next = api.calls
    .filter((url) => url.includes('/api/search/get'))
    .map((url) => new URL(url).searchParams.get('start'));
  assert.deepEqual(next, ['1', '3']);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS count FROM sources_runs WHERE id LIKE 'preparation:%:job:%'",
        )
        .first<{ count: number }>()
    )?.count,
    90,
  );
});

void test('incomplete inventory pages never advance discovery or enqueue partial records', async () => {
  const { db } = database(),
    api = service();
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/api/search/get'))
      return Response.json({
        response: { numFound: 60, docs: [{ shiurID: 1 }] },
      });
    return api.fetcher(input, init);
  };
  const result = await runSourcePreparation({
    ...options(db, fetcher),
    catalogPages: 2,
  });
  assert.equal(result.discoveryFailed, true);
  assert.equal(result.outcome, 'upstream-unavailable');
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS count FROM sources_runs WHERE id LIKE 'preparation:%:inventory'",
        )
        .first<{ count: number }>()
    )?.count,
    0,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT lease FROM sources_runs WHERE id='preparation:runner-lock'",
        )
        .first<{ lease: number }>()
    )?.lease,
    0,
  );
  await assert.rejects(
    preparationCatalog(1, new AbortController().signal, async () =>
      Response.json({
        response: { numFound: 2, docs: [{ shiurID: 1 }, { shiurID: 1 }] },
      }),
    ),
    /Duplicate/,
  );
});

void test('concurrent runners share a durable lease and expired owners cannot overwrite queue state', async () => {
  const { db } = database(),
    api = service();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/api/transcript')) {
      entered();
      await held;
    }
    return api.fetcher(input, init);
  };
  const config = options(db, fetcher);
  const first = runSourcePreparation({ ...config, ids: ['42'] });
  await started;
  const other = await runSourcePreparation(config);
  assert.equal(other.outcome, 'locked');
  await db
    .prepare('UPDATE sources_runs SET lease=? WHERE id=?')
    .bind(Date.now() + 60000, 'preparation:runner-lock')
    .run();
  release();
  await assert.rejects(first, /ownership changed/);
  assert.ok(
    (await db
      .prepare('SELECT lease FROM sources_runs WHERE id=?')
      .bind('preparation:runner-lock')
      .first<{ lease: number }>())!.lease > 0,
  );
});

void test('disabled outputs stop before database access; malformed options stop before HTTP access', async () => {
  const api = service();
  const db: SearchDatabase = {
    prepare: () => {
      throw new Error('Must not read');
    },
    batch: async () => [],
  };
  const result = await runSourcePreparation({
    ...options(db, api.fetcher),
    features: { links: false, sheets: false },
  });
  assert.equal(result.outcome, 'disabled');
  assert.equal(api.calls.length, 0);
  await assert.rejects(
    runSourcePreparation({
      ...options(db, api.fetcher),
      ids: ['42;echo secret'],
    }),
    /Invalid/,
  );
  assert.equal(api.calls.length, 0);
});

void test('cache capacity pruning preserves prepared sheets and the backlog, even when their payload contains done', async () => {
  const { db } = database();
  const expires = Date.now() + 86400_000;
  for (let i = 0; i < 320; i++)
    await db
      .prepare(
        'INSERT INTO sources_runs(id,payload,lease,expires) VALUES(?,?,0,?)',
      )
      .bind(`creator:old:${i}`, JSON.stringify({ done: true }), expires)
      .run();
  for (const id of ['prepared:creator-v5:42', 'preparation:creator-v5:job:42'])
    await db
      .prepare(
        'INSERT INTO sources_runs(id,payload,lease,expires) VALUES(?,?,0,?)',
      )
      .bind(id, JSON.stringify({ done: true }), expires)
      .run();
  await pruneSourceCache(db);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS count FROM sources_runs WHERE id LIKE 'prepared:%' OR id LIKE 'preparation:%'",
        )
        .first<{ count: number }>()
    )?.count,
    2,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS count FROM sources_runs WHERE id LIKE 'creator:old:%'",
        )
        .first<{ count: number }>()
    )?.count,
    256,
  );
});

void test('oversized upstream responses are cancelled before parsing', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8_000_001));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    preparationFetch(
      new URL('https://website.test'),
      new AbortController().signal,
      async () => response,
    ),
    /size limit/,
  );
  assert.equal(cancelled, true);
});

void test('workflow runs the actual script with pinned actions and safely passes manual IDs through env', () => {
  const workflow = readFileSync('.github/workflows/sources.yml', 'utf8');
  assert.match(workflow, /7,37 \* \* \* \*/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run sources:prepare/);
  assert.match(workflow, /--ids "\$SOURCE_IDS"/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.equal((workflow.match(/uses: [^\n]+@[a-f0-9]{40}/g) || []).length, 2);
});

void test('compact prepared references survive cache pruning alongside runner checkpoints and leases', async () => {
  const { db, sqlite } = database();
  const expires = Date.now() + 86400000;
  const insert = sqlite.prepare(
    'INSERT INTO sources_runs(id,payload,lease,expires) VALUES(?,?,?,?)',
  );
  for (let n = 0; n < 300; n++)
    insert.run('prepared:creator-v5:' + n, '{}', 0, expires + n);
  insert.run('preparation:creator-v4:inventory', '{"page":400}', 0, expires);
  insert.run('preparation:runner-lock', '{}', expires, expires);
  insert.run('prepared:creator-v5:active', '{}', expires, expires);
  await pruneSourceCache(db);
  assert.equal(
    Number(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM sources_runs WHERE id LIKE 'prepared:%' AND lease=0",
        )
        .get()!.n,
    ),
    300,
  );
  assert.ok(
    sqlite
      .prepare(
        "SELECT id FROM sources_runs WHERE id='preparation:creator-v4:inventory'",
      )
      .get(),
  );
  assert.ok(
    sqlite
      .prepare("SELECT id FROM sources_runs WHERE id='preparation:runner-lock'")
      .get(),
  );
  assert.ok(
    sqlite
      .prepare(
        "SELECT id FROM sources_runs WHERE id='prepared:creator-v5:active'",
      )
      .get(),
  );
  sqlite.close();
});

void test('runner prepares sources from a description with no transcript or notes and never warms source text', async () => {
  const { db } = database(),
    api = service();
  api.setMissing();
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    calls.push(url.pathname);
    if (url.pathname === '/api/shiur/details')
      return Response.json({
        shiurID: 42,
        shiurDescription: '<p>See Genesis 1:1.</p>',
      });
    if (url.pathname === '/api/find-refs')
      return Response.json({
        body: {
          results: [
            {
              startChar: 4,
              endChar: 15,
              text: 'Genesis 1:1',
              refs: ['Genesis 1:1'],
              linkFailed: false,
            },
          ],
          refData: {
            'Genesis 1:1': {
              heRef: 'בראשית א׳:א׳',
              url: 'Genesis.1.1',
              primaryCategory: 'Tanakh',
            },
          },
          debugData: [
            [
              {
                context_ref: null,
                context_type: null,
                resolved_part_classes: ['RawRefPart'],
                orig_part_types: ['NAMED', 'NUMBERED'],
              },
            ],
          ],
        },
      });
    if (url.pathname.startsWith('/api/ref/'))
      return Response.json({
        is_ref: true,
        normalized: 'Genesis 1:1',
        hebrew: 'בראשית א׳:א׳',
        url_ref: 'Genesis.1.1',
        node_type: 'JaggedArrayNode',
        depth: 2,
        address_types: ['Perek', 'Pasuk'],
        start_indexes: [1, 1],
        end_indexes: [1, 1],
        start_labels: ['1', '1'],
        end_labels: ['1', '1'],
      });
    return api.fetcher(input, init);
  };
  const result = await runSourcePreparation({
    ...options(db, fetcher),
    ids: ['42'],
  });
  assert.equal(result.ready, 1);
  const row = await db
    .prepare(
      "SELECT payload FROM sources_runs WHERE id='prepared:creator-v5:42'",
    )
    .first<{ payload: string }>();
  assert.deepEqual(JSON.parse(row!.payload).refs, ['Genesis 1:1']);
  assert.ok(!calls.some((path) => path.startsWith('/api/v3/texts')));
});
