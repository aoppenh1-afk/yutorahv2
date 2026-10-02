import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  advanceSources,
  type SourceTranscript,
  type SourcesResult,
} from '../lib/sources';
import { sourcesResponse } from '../lib/sources-handler';
import {
  sourceText,
  type LinkerBody,
  type LinkerDebug,
  type RefMetadata,
} from '../lib/sefaria';
import { sourceHighlights } from '../lib/source-highlights';
import { renderSourceSheet } from '../lib/source-sheet';
import {
  postgresSearchSql,
  postgresSearchDatabase,
} from '../lib/search-postgres';
import { migrateSourcesSchema } from '../scripts/migrate-search-schema';
import type { SearchDatabase, SearchStatement } from '../lib/search-storage';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('drizzle/0004_sources.sql', 'utf8'));
  const prepare = (sql: string, params: unknown[] = []): SearchStatement => ({
    bind: (...values) => prepare(sql, values),
    first: async <T>() =>
      (sqlite.prepare(sql).get(...(params as never[])) as T) ?? null,
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
  return {
    prepare,
    batch: async (statements: SearchStatement[]) =>
      Promise.all(statements.map((s) => s.run())),
  } satisfies SearchDatabase;
}
const transcript = (...text: string[]): SourceTranscript => ({
  transcriptId: 'transcript-fixture-1',
  segments: text.map((text, i) => ({
    text,
    startMs: i * 60000,
    endMs: (i + 1) * 60000,
  })),
});
const rawDebug: LinkerDebug = {
  context_ref: null,
  context_type: null,
  resolved_part_classes: ['RawRefPart', 'RawRefPart'],
  orig_part_types: ['NAMED', 'NUMBERED'],
};
function bodyResults(
  body: string,
  citations: Array<{
    mention: string;
    ref: string;
    category?: string;
    debug?: LinkerDebug;
    ambiguous?: boolean;
    failed?: boolean;
  }>,
): LinkerBody {
  const results: LinkerBody['results'] = [];
  const refData: LinkerBody['refData'] = {};
  const debugData: LinkerDebug[][] = [];
  for (const c of citations) {
    for (const match of body.matchAll(
      new RegExp(c.mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'),
    )) {
      const startChar = Array.from(body.slice(0, match.index)).length;
      results.push({
        startChar,
        endChar: startChar + Array.from(c.mention).length,
        text: c.mention,
        refs: c.ambiguous ? [c.ref, 'Exodus 1:1'] : [c.ref],
        linkFailed: c.failed ?? false,
      });
      refData[c.ref] = {
        heRef: 'הפניה',
        url: c.ref.replaceAll(' ', '_'),
        primaryCategory: c.category || 'Tanakh',
      };
      debugData.push([c.debug || rawDebug]);
    }
  }
  return { results, refData, debugData };
}
function metadata(
  ref: string,
  options: Partial<RefMetadata> = {},
): RefMetadata {
  const match = ref.match(/\s(\d+[ab]?)(?::(\d+))?(?::(\d+))?$/);
  const labels = match ? match.slice(1).filter(Boolean) : [];
  const talmud = ref.includes('Shabbat');
  return {
    is_ref: true,
    normalized: ref,
    hebrew: 'הפניה',
    url_ref: ref.replaceAll(' ', '_').replaceAll(':', '.'),
    node_type: 'JaggedArrayNode',
    depth: ref.startsWith('Tosafot') ? 3 : 2,
    address_types: talmud
      ? ['Talmud', 'Integer', 'Integer']
      : ['Perek', 'Pasuk'],
    start_indexes: labels.map((label, i) =>
      talmud && i === 0 ? 4 : Number(label),
    ),
    end_indexes: labels.map((label, i) =>
      talmud && i === 0 ? 4 : Number(label),
    ),
    start_labels: labels,
    end_labels: labels,
    ...options,
  };
}
function sefariaMock(
  makeBody: (body: string) => LinkerBody,
  refs: Record<string, RefMetadata> = {},
  asyncTask = false,
) {
  const calls: string[] = [];
  let result: LinkerBody;
  let pending = asyncTask;
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    if (url.includes('/find-refs')) {
      const data = JSON.parse(init?.body as string);
      assert.equal(
        data.text.title,
        '',
        'the shiur title must not provide source context',
      );
      assert.ok(
        ['en', 'he'].includes(data.lang),
        'each script uses its own Sefaria model',
      );
      result = makeBody(data.text.body);
      return Response.json(
        asyncTask ? { task_id: 'fixture-task' } : { body: result },
        { status: asyncTask ? 202 : 200 },
      );
    }
    if (url.includes('/async/')) {
      if (pending) {
        pending = false;
        return Response.json(
          { ready: false, state: 'PENDING' },
          { status: 202 },
        );
      }
      return Response.json({
        ready: true,
        state: 'SUCCESS',
        result: { body: result },
      });
    }
    const ref = decodeURIComponent(url.split('/api/ref/')[1] || '');
    return Response.json(refs[ref] || metadata(ref));
  };
  return { fetcher, calls };
}
async function finish(
  db: SearchDatabase,
  t: SourceTranscript,
  fetcher: typeof fetch,
) {
  let result: SourcesResult;
  for (let i = 0; i < 100; i++) {
    result = await advanceSources(db, t, fetcher);
    if (result.status === 'ready') return result;
  }
  throw new Error('Extraction did not finish');
}

void test('recorded live Sefaria response: only explicit sources, canonical dedupe, and transcript timestamps', async () => {
  // Recorded 2026-10-02 from /find-refs?debug=1&with_text=0, then /async/{task}.
  const body =
    'The Gemara in Shabbos discusses this. See Shabbat 2b. Tosafot on Shabbat 2b, and Tosafot on Shabbat 2b:1. Genesis 1:1. בראשית א:א.';
  const fixture = JSON.parse(
    readFileSync('tests/fixtures/sefaria-linker.json', 'utf8'),
  ).result.body as LinkerBody;
  const mock = sefariaMock(() => fixture, {}, true);
  const db = database();
  const result = await finish(db, transcript(body), mock.fetcher);
  assert.deepEqual(
    result.sources.map((s) => s.ref),
    ['Shabbat 2b', 'Tosafot on Shabbat 2b:1', 'Genesis 1:1'],
  );
  assert.equal(result.sources[2].occurrences.length, 2);
  assert.equal(result.omitted, 1);
  assert.equal(result.progress, 100);
  assert.ok(
    result.sources.every((s) => s.url.startsWith('https://www.sefaria.org/')),
  );
  const count = mock.calls.length;
  assert.deepEqual(await finish(db, transcript(body), mock.fetcher), result);
  assert.equal(
    mock.calls.length,
    count,
    'finished runs reuse the durable cache',
  );
  assert.equal(
    mock.calls.filter((c) => c.includes('/find-refs')).length,
    2,
    'polling never resubmits an async task',
  );
});

void test('missing daf, missing amud, chapter-only citations, and unspecified Tosfos comments are omitted', async () => {
  const body =
    'Gemara Shabbos. Shabbat 2. Tosfos daf 2b. Tosfos Shabbos 2b. Genesis 1. Shabbos 2b.';
  const mock = sefariaMock((text) =>
    bodyResults(text, [
      { mention: 'Shabbos', ref: 'Shabbat', category: 'Talmud' },
      { mention: 'Shabbat 2', ref: 'Shabbat 2a', category: 'Talmud' },
      {
        mention: 'Tosfos daf 2b',
        ref: 'Tosafot on Shabbat 2b',
        category: 'Commentary',
        debug: {
          ...rawDebug,
          context_ref: 'Shabbat 2b',
          context_type: 'CURRENT_BOOK',
        },
      },
      {
        mention: 'Tosfos Shabbos 2b',
        ref: 'Tosafot on Shabbat 2b',
        category: 'Commentary',
      },
      { mention: 'Genesis 1', ref: 'Genesis 1' },
      { mention: 'Shabbos 2b', ref: 'Shabbat 2b', category: 'Talmud' },
    ]),
  );
  const result = await finish(database(), transcript(body), mock.fetcher);
  assert.deepEqual(
    result.sources.map((s) => s.ref),
    ['Shabbat 2b'],
  );
  assert.equal(
    result.sources[0].occurrences.length,
    1,
    'a partial Gemara match inside Tosfos is not shown',
  );
});

void test('ambiguous, failed, ibid, inferred, malformed, and mismatched offset results never become links', async () => {
  const input =
    'Genesis 1:1; ibid. 1:2; ambiguous; failed; inferred; wrong span; no debug.';
  const mock = sefariaMock((text) => {
    const body = bodyResults(text, [
      { mention: 'Genesis 1:1', ref: 'Genesis 1:1' },
      {
        mention: 'ibid. 1:2',
        ref: 'Genesis 1:2',
        debug: {
          ...rawDebug,
          orig_part_types: ['IBID', 'NUMBERED'],
          context_ref: 'Genesis 1:1',
          context_type: 'IBID',
        },
      },
      { mention: 'ambiguous', ref: 'Genesis 1:3', ambiguous: true },
      { mention: 'failed', ref: 'Genesis 1:4', failed: true },
      {
        mention: 'inferred',
        ref: 'Genesis 1:5',
        debug: {
          ...rawDebug,
          resolved_part_classes: ['TermContext', 'RawRefPart'],
        },
      },
      { mention: 'wrong span', ref: 'Genesis 1:6' },
      { mention: 'no debug', ref: 'Genesis 1:7' },
    ]);
    body.results[5].startChar++;
    body.debugData[6] = [];
    return body;
  });
  const result = await finish(database(), transcript(input), mock.fetcher);
  assert.deepEqual(
    result.sources.map((s) => s.ref),
    ['Genesis 1:1'],
  );
  assert.equal(result.omitted, 6);
});

void test('Hebrew, emoji, repeated mentions, and cross-segment citations retain exact UTF-16 highlights and seek times', async () => {
  const t = transcript(
    '😀 Read Genesis',
    '1:1. בראשית א:א.',
    'Again Genesis 1:1.',
  );
  const mock = sefariaMock((body) =>
    bodyResults(body, [
      { mention: 'Genesis\n\n1:1', ref: 'Genesis 1:1' },
      { mention: 'בראשית א:א', ref: 'Genesis 1:1' },
      { mention: 'Genesis 1:1', ref: 'Genesis 1:1' },
    ]),
  );
  const result = await finish(database(), t, mock.fetcher);
  assert.equal(result.sources.length, 1);
  const occurrences = result.sources[0].occurrences;
  assert.deepEqual(
    occurrences.map((o) => o.startMs),
    [0, 60000, 120000],
  );
  assert.deepEqual(occurrences[0].spans, [
    { segmentIndex: 0, startChar: 8, endChar: 15 },
    { segmentIndex: 1, startChar: 0, endChar: 3 },
  ]);
  assert.deepEqual(
    sourceHighlights(result.sources, 0).map((span) =>
      t.segments[0].text.slice(span.startChar, span.endChar),
    ),
    ['Genesis'],
  );
});

void test('bounded overlapping chunks retain a boundary citation once without inventing sources', async () => {
  const t = transcript(
    'a '.repeat(5950) + 'Genesis 1:1. ' + 'b '.repeat(6000) + 'Genesis 1:1.',
  );
  const sent: number[] = [];
  const mock = sefariaMock((body) => {
    sent.push(Array.from(body).length);
    return bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]);
  });
  const result = await finish(database(), t, mock.fetcher);
  assert.ok(sent.length >= 3);
  assert.ok(sent.every((n) => n <= 12000));
  assert.equal(result.sources[0].occurrences.length, 2);
});

void test('HTTP uses only persisted transcript text; arbitrary text requests and uncited sheet references do not add sources', async () => {
  const t = transcript('Genesis 1:1.');
  const mock = sefariaMock((body) => {
    assert.equal(body, t.segments[0].text);
    return bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]);
  });
  const dependencies = {
    db: database(),
    transcript: async () =>
      Response.json({
        ...t,
        title: 'Exodus 1:1',
        notes: { markdown: 'Exodus 2:2' },
      }),
    fetcher: mock.fetcher,
  };
  const invalid = await sourcesResponse(
    new Request('https://example.org/api/sources?id=abc'),
    dependencies,
  );
  assert.equal(invalid.status, 400);
  const pending = await sourcesResponse(
    new Request('https://example.org/api/sources?id=1&text=Exodus%202%3A2'),
    dependencies,
  );
  assert.equal(pending.status, 202);
  assert.equal(pending.headers.get('Retry-After'), '2');
  const ready = await sourcesResponse(
    new Request('https://example.org/api/sources?id=1'),
    dependencies,
  );
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('Cache-Control'), 'no-store');
  const uncited = await sourcesResponse(
    new Request('https://example.org/api/source-text?id=1&ref=Exodus%202%3A2'),
    dependencies,
    true,
  );
  assert.equal(uncited.status, 404);
  assert.ok(!mock.calls.some((url) => url.includes('/texts/')));
  const missing = await sourcesResponse(
    new Request('https://example.org/api/sources?id=1'),
    {
      ...dependencies,
      transcript: async () =>
        Response.json({ error: 'missing' }, { status: 404 }),
    },
  );
  assert.equal(missing.status, 404);
});

void test('transient metadata failures preserve progress and release the lease for a retry', async () => {
  const db = database();
  const t = transcript('Genesis 1:1.');
  const mock = sefariaMock((body) =>
    bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
  );
  await advanceSources(db, t, mock.fetcher);
  const failed: typeof fetch = async () => {
    throw new Error('private upstream details');
  };
  const response = await sourcesResponse(
    new Request('https://example.org/api/sources?id=1'),
    { db, transcript: async () => Response.json(t), fetcher: failed },
  );
  assert.equal(response.status, 503);
  assert.ok(
    !JSON.stringify(await response.json()).includes('private upstream'),
  );
  const result = await finish(db, t, mock.fetcher);
  assert.equal(result.sources.length, 1);
  assert.equal(
    mock.calls.filter((url) => url.includes('/find-refs')).length,
    1,
  );
});

void test('simultaneous requests share a durable lease, and a changed transcript/timing invalidates the cache', async () => {
  const db = database();
  const t = transcript('Genesis 1:1.');
  const mock = sefariaMock((body) =>
    bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
  );
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const slow: typeof fetch = async (...args) => {
    entered();
    await wait;
    return mock.fetcher(...args);
  };
  const first = advanceSources(db, t, slow);
  await started;
  const second = await advanceSources(db, t, mock.fetcher);
  assert.equal(second.status, 'pending');
  assert.equal(mock.calls.length, 0);
  release();
  await first;
  await finish(db, t, mock.fetcher);
  const changed = { ...t, segments: [{ ...t.segments[0], startMs: 1000 }] };
  const result = await finish(db, changed, mock.fetcher);
  assert.equal(result.sources[0].occurrences[0].startMs, 1000);
  assert.equal(
    mock.calls.filter((url) => url.includes('/find-refs')).length,
    2,
  );
});

void test('failed async tasks can be resubmitted on retry instead of remaining permanently stuck', async () => {
  const db = database(),
    t = transcript('Genesis 1:1.');
  const mock = sefariaMock(
    (body) =>
      bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
    {},
    true,
  );
  await advanceSources(db, t, mock.fetcher);
  await assert.rejects(
    advanceSources(db, t, async () =>
      Response.json({
        state: 'FAILURE',
        ready: true,
        error: 'internal detail',
      }),
    ),
  );
  const result = await finish(db, t, mock.fetcher);
  assert.equal(result.sources.length, 1);
  assert.equal(
    mock.calls.filter((url) => url.includes('/find-refs')).length,
    2,
  );
});

void test('source text requires the same canonical ref, preserves edition attribution, and marks excerpts', async () => {
  const fetcher: typeof fetch = async (input) => {
    assert.match(
      input instanceof Request ? input.url : input.toString(),
      /return_format=text_only/,
    );
    return Response.json({
      ref: 'Genesis 1:1',
      categories: ['Tanakh', 'Torah'],
      versions: [
        {
          language: 'he',
          direction: 'rtl',
          versionTitle: 'Hebrew edition',
          license: 'CC-BY-SA',
          versionSource: 'https://example.org/edition',
          text: '<b>Hebrew text</b>',
        },
        {
          language: 'en',
          direction: 'ltr',
          versionTitle: 'Translation',
          license: 'PD',
          text: Array.from({ length: 10 }, (_, i) => `Line ${i}`),
        },
      ],
    });
  };
  const result = await sourceText('Genesis 1:1', fetcher);
  assert.equal(result.editions[0].text[0], 'Hebrew text');
  assert.equal(result.editions[0].license, 'CC-BY-SA');
  assert.equal(result.editions[0].versionSource, 'https://example.org/edition');
  assert.equal(result.editions[1].text.length, 8);
  assert.equal(result.editions[1].truncated, true);
  await assert.rejects(
    sourceText('Genesis 1:1', async () =>
      Response.json({ ref: 'Genesis 1', versions: [], categories: [] }),
    ),
    /different reference/,
  );
});

void test('download/print document escapes text and includes categories, Sefaria links, edition attribution, and timestamp deep links', async () => {
  const mock = sefariaMock((body) =>
    bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
  );
  const result = await finish(
    database(),
    transcript('Genesis 1:1.'),
    mock.fetcher,
  );
  const html = renderSourceSheet({
    shiurId: 42,
    title: '<script>alert(1)</script>',
    teacher: 'A & B',
    origin: 'https://example.org',
    sources: result.sources,
    limited: false,
    texts: {
      'Genesis 1:1': {
        ref: 'Genesis 1:1',
        categories: ['Tanakh', 'Torah'],
        editions: [
          {
            language: 'en',
            direction: 'ltr',
            title: 'Edition',
            license: 'PD',
            versionSource: null,
            text: ['<img src=x onerror=alert(1)>'],
            truncated: true,
          },
        ],
      },
    },
  });
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Tanakh \/ Torah/);
  assert.match(html, /shiur=42&amp;t=0/);
  assert.match(html, /https:\/\/www.sefaria.org\//);
  assert.match(html, /Edition · en · PD/);
  assert.match(html, /Excerpt/);
  assert.match(html, /@media print/);
});

void test('sources storage SQL is translated into the isolated PostgreSQL search schema', () => {
  assert.equal(
    postgresSearchSql(
      'UPDATE sources_runs SET payload = ?, expires = ? WHERE id = ? AND lease = ?',
    ),
    'UPDATE yutorah_search.sources_runs SET payload = $1, expires = $2 WHERE id = $3 AND lease = $4',
  );
});

void test('mixed-language model disagreements are omitted while independent explicit citations are retained', async () => {
  let language: 'en' | 'he';
  const mock = sefariaMock((body) =>
    bodyResults(body, [
      {
        mention: 'Genesis 1:1',
        ref: language === 'en' ? 'Genesis 1:1' : 'Genesis 1:2',
      },
      { mention: 'שבת ב ע״ב', ref: 'Shabbat 2b', category: 'Talmud' },
    ]),
  );
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.body) language = JSON.parse(init.body as string).lang;
    return mock.fetcher(input, init);
  };
  const result = await finish(
    database(),
    transcript('Genesis 1:1. שבת ב ע״ב.'),
    fetcher,
  );
  assert.deepEqual(
    result.sources.map((s) => s.ref),
    ['Shabbat 2b'],
  );
  assert.equal(result.sources[0].occurrences.length, 1);
});

void test(
  'PostgreSQL migration and durable extraction preserve epochs, leases, canonical sources and timestamps',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = 'sources_' + crypto.randomUUID().replaceAll('-', '');
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      const db = postgresSearchDatabase(pool, schema);
      await migrateSourcesSchema(db);
      await migrateSourcesSchema(db);
      const mock = sefariaMock(
        (body) =>
          bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
        {},
        true,
      );
      const t = transcript('See Genesis 1:1.', 'Again Genesis 1:1.');
      const result = await finish(db, t, mock.fetcher);
      assert.equal(result.sources.length, 1);
      assert.deepEqual(
        result.sources[0].occurrences.map((o) => o.startMs),
        [0, 60000],
      );
      assert.deepEqual(
        await finish(postgresSearchDatabase(pool, schema), t, mock.fetcher),
        result,
      );
      assert.equal(
        mock.calls.filter((url) => url.includes('/find-refs')).length,
        1,
      );
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  },
);
