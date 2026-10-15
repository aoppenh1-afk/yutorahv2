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
import {
  sourceHighlights,
  indexSourceHighlights,
} from '../lib/source-highlights';
import { renderSourceSheet } from '../lib/source-sheet';
import {
  postgresSearchSql,
  postgresSearchDatabase,
} from '../lib/search-postgres';
import { migrateSourcesSchema } from '../scripts/migrate-search-schema';
import { sourceRequest, sourceRetryDelay } from '../lib/source-request';
import { cachedSourceText, sourceSnapshot } from '../lib/sources-cache';
import { SourcesLeaseError } from '../lib/sources';
import { sourceEditions } from '../lib/source-sheet';
import { preparePublishedSources } from '../lib/prepare-published-sources';
import { evaluateSourcesCorpus } from '../scripts/evaluate-sources';
import type { SearchDatabase, SearchStatement } from '../lib/search-storage';
import { spokenCitations } from '../lib/spoken-sources';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('drizzle/0005_sources.sql', 'utf8'));
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

void test('completed sources use trusted publication versions without another transcript read or stored input copy', async () => {
  const db = database();
  const data: SourceTranscript = {
    transcriptId: 'immutable-fixture',
    segments: [],
  };
  let loads = 0;
  const searchVersion = 'a'.repeat(64),
    version = 'b'.repeat(64);
  const deps = {
    db,
    status: async () =>
      Response.json({
        transcriptId: data.transcriptId,
        searchVersion,
        version,
      }),
    transcript: async (_id: string, requestedVersion?: string) => {
      loads++;
      assert.equal(requestedVersion, version);
      return Response.json(data);
    },
  };
  const url = `https://example.test/api/sources?id=42&revision=${data.transcriptId}`;
  assert.equal((await sourcesResponse(new Request(url), deps)).status, 200);
  assert.equal((await sourcesResponse(new Request(url), deps)).status, 200);
  assert.equal(loads, 1);
  assert.equal(
    (await db
      .prepare("SELECT count(*) AS n FROM sources_runs WHERE id LIKE 'input:%'")
      .first<{ n: number }>())!.n,
    0,
  );
  assert.equal(
    (
      await sourcesResponse(
        new Request(url.replace(data.transcriptId, 'old-transcript')),
        deps,
      )
    ).status,
    409,
  );
});
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
  const talmud = /(?:Shabbat|Menachot|Berakhot|Eruvin)/u.test(ref);
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
      talmud && i === 0
        ? parseInt(label) * 2 - (label.endsWith('b') ? 0 : 1)
        : Number(label),
    ),
    end_indexes: labels.map((label, i) =>
      talmud && i === 0
        ? parseInt(label) * 2 - (label.endsWith('a') ? 1 : 0)
        : Number(label),
    ),
    start_labels:
      talmud && labels.length === 1 && /^\d+$/u.test(labels[0])
        ? [labels[0] + 'a']
        : labels,
    end_labels:
      talmud && labels.length === 1 && /^\d+$/u.test(labels[0])
        ? [labels[0] + 'b']
        : labels,
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

void test('a daf without an amud links the entire daf rather than guessing a side', async () => {
  const mock = sefariaMock(
    (body) =>
      bodyResults(body, [
        { mention: 'Menachos 37', ref: 'Menachot 37a', category: 'Talmud' },
      ]),
    {
      'Menachot 37': metadata('Menachot 37', {
        depth: 1,
        address_types: ['Talmud'],
        start_indexes: [73],
        end_indexes: [74],
        start_labels: ['37a'],
        end_labels: ['37b'],
      }),
      'Menachot 37a': metadata('Menachot 37a', {
        depth: 1,
        address_types: ['Talmud'],
        start_indexes: [73],
        end_indexes: [73],
        start_labels: ['37a'],
        end_labels: ['37a'],
      }),
    },
  );
  const result = await finish(
    database(),
    transcript('See Menachos 37.'),
    mock.fetcher,
  );
  assert.deepEqual(
    result.sources.map((source) => source.ref),
    ['Menachot 37'],
  );
  assert.equal(result.sources[0].occurrences[0].mention, 'Menachos 37');
});

void test('spoken Shulchan Aruch locations are recovered across intervening words and segments', async () => {
  const t = transcript(
    '😀 It says in shulchan aruch in auruch chaim the answer.',
    'In siman 37 sif katan daled.',
  );
  const mock = sefariaMock(
    () => ({ results: [], refData: {}, debugData: [] }),
    {
      'Shulchan Arukh, Orach Chayim 37': metadata(
        'Shulchan Arukh, Orach Chayim 37',
        {
          depth: 2,
          address_types: ['Siman', 'Seif'],
          start_indexes: [37],
          end_indexes: [37],
          start_labels: ['37'],
          end_labels: ['37'],
        },
      ),
    },
  );
  const result = await finish(database(), t, mock.fetcher);
  assert.deepEqual(
    result.sources.map((source) => source.ref),
    ['Shulchan Arukh, Orach Chayim 37'],
  );
  assert.equal(result.sources[0].occurrences[0].startMs, 0);
  assert.deepEqual(
    result.sources[0].occurrences[0].spans.map((span) =>
      t.segments[span.segmentIndex].text.slice(span.startChar, span.endChar),
    ),
    ['shulchan aruch', 'auruch chaim', 'siman 37'],
  );
});

void test('spoken names, English numbers, Hebrew numerals, amud words and seif katan are validated without a linker match', async () => {
  for (const [mention, ref, category] of [
    ['Menachos 37', 'Menachot 37', 'Talmud'],
    [
      'Menachos discusses this question. Look at daf thirty seven.',
      'Menachot 37',
      'Talmud',
    ],
    ['Menachos daf thirty-seven amud beis', 'Menachot 37b', 'Talmud'],
    ['Look at daf thirty seven in Menachos', 'Menachot 37', 'Talmud'],
    ['מנחות דף ל״ז ע״א', 'Menachot 37a', 'Talmud'],
    ['ראש השנה דף ט״ז', 'Rosh Hashanah 16', 'Talmud'],
    [
      'Mishna Berura says in siman thirty seven seif katan daled',
      'Mishnah Berurah 37:4',
      'Commentary',
    ],
    [
      'Mishnah Berurah siman three hundred and twenty-eight sif katan yud',
      'Mishnah Berurah 328:10',
      'Commentary',
    ],
    ['משנה ברורה בסימן ל״ז סעיף קטן ד׳', 'Mishnah Berurah 37:4', 'Commentary'],
    [
      'Shulchan Aruch in Orach Chaim explains it. In siman 37 sif beis',
      'Shulchan Arukh, Orach Chayim 37:2',
      'Halakhah',
    ],
    [
      'Shulchan Aruch in Yoreh Deah siman 116',
      "Shulchan Arukh, Yoreh De'ah 116",
      'Halakhah',
    ],
    ['Tosfos on Menachos 37b', 'Tosafot on Menachot 37b', 'Commentary'],
    [
      'Tosfos in daf thirty seven amud beis in Menachos',
      'Tosafot on Menachot 37b',
      'Commentary',
    ],
    [
      'Rambam in Hilchos Brachos perek five halacha eight',
      'Mishneh Torah, Blessings 5:8',
      'Halakhah',
    ],
    [
      'רמב״ם in the tenth פרק of הלכות אישות הלכה י״ב',
      'Mishneh Torah, Marriage 10:12',
      'Halakhah',
    ],
    [
      'Chasam Sofer in Orach Chaim siman 115',
      'Responsa Chatam Sofer, Orach Chayim 115',
      'Responsa',
    ],
  ]) {
    const talmud = category === 'Talmud' || ref.includes(' on Menachot');
    const labels = ref
      .match(/\s(\d+[ab]?)(?::(\d+))?$/)!
      .slice(1)
      .filter(Boolean);
    const mock = sefariaMock(
      () => ({ results: [], refData: {}, debugData: [] }),
      {
        [ref]: metadata(ref, {
          address_types: talmud
            ? ['Talmud', 'Integer']
            : ['Siman', 'SeifKatan'],
          start_indexes: labels.map((label) => parseInt(label)),
          end_indexes: labels.map((label) => parseInt(label)),
          start_labels:
            talmud && !/[ab]$/u.test(labels[0]) ? [labels[0] + 'a'] : labels,
          end_labels:
            talmud && !/[ab]$/u.test(labels[0]) ? [labels[0] + 'b'] : labels,
        }),
      },
    );
    const result = await finish(database(), transcript(mention), mock.fetcher);
    assert.deepEqual(
      result.sources.map((s) => s.ref),
      [ref],
      mention,
    );
    assert.equal(result.sources[0].category, category, mention);
  }
});

void test('spoken recovery does not borrow locations from another source, distant segments, or missing sections', async () => {
  for (const mention of [
    'Shulchan Aruch in siman 37.',
    'Shulchan Aruch HaRav in Orach Chaim siman 37.',
    'Menachos. Mishnah Berurah siman 37.',
    'Mishnah Berurah ' + 'word '.repeat(60) + 'siman 37.',
    'Mishnah Shabbos perek two.',
    'Yerushalmi Shabbos daf 37.',
    'Shabbos 37 minutes after sunset.',
    'Menachos 37th birthday.',
  ]) {
    assert.deepEqual(
      spokenCitations(mention).map((c) => c.ref),
      mention === 'Menachos. Mishnah Berurah siman 37.'
        ? ['Mishnah Berurah 37']
        : [],
      mention,
    );
    const mock = sefariaMock(() => ({
      results: [],
      refData: {},
      debugData: [],
    }));
    const result = await finish(database(), transcript(mention), mock.fetcher);
    assert.ok(
      result.sources.every((s) => s.ref === 'Mishnah Berurah 37'),
      mention,
    );
    assert.ok(!result.sources.some((s) => s.category === 'Talmud'), mention);
  }
  const t = transcript('Menachos.', 'Look at daf 37.');
  t.segments[1].startMs = 240000;
  t.segments[1].endMs = 250000;
  const mock = sefariaMock(() => ({ results: [], refData: {}, debugData: [] }));
  assert.equal((await finish(database(), t, mock.fetcher)).sources.length, 0);
  assert.deepEqual(
    spokenCitations(
      "The Gemara in Eruvin daf forty amud aleph says that Tisha B'Av fell on Shabbos.",
    ).map((c) => c.ref),
    ['Eruvin 40a'],
  );
});

void test('a spoken citation spanning overlapping chunks keeps one occurrence and only its source words', async () => {
  const text =
    'a '.repeat(5950) +
    'Shulchan Aruch in Orach Chaim ' +
    'explanation '.repeat(10) +
    'in siman 37. ' +
    'b '.repeat(100);
  const mock = sefariaMock(() => ({ results: [], refData: {}, debugData: [] }));
  const t = transcript(text);
  const result = await finish(database(), t, mock.fetcher);
  assert.deepEqual(
    result.sources.map((source) => source.ref),
    ['Shulchan Arukh, Orach Chayim 37'],
  );
  assert.equal(result.sources[0].occurrences.length, 1);
  assert.deepEqual(
    result.sources[0].occurrences[0].spans.map((span) =>
      text.slice(span.startChar, span.endChar),
    ),
    ['Shulchan Aruch', 'Orach Chaim', 'siman 37'],
  );
});

void test('whole-daf ranges retain both sides and mixed ranges expand only the unspecified endpoint', async () => {
  for (const [mention, ref, from, to] of [
    ['Menachos 37-38', 'Menachot 37-38', '37a', '38b'],
    ['Menachos 37a through 38', 'Menachot 37a-38b', '37a', '38b'],
    ['Menachos 37 through 38a', 'Menachot 37a-38a', '37a', '38a'],
  ]) {
    const mock = sefariaMock(
      () => ({ results: [], refData: {}, debugData: [] }),
      {
        [ref]: metadata(ref, {
          address_types: ['Talmud', 'Integer'],
          start_indexes: [73],
          end_indexes: [76],
          start_labels: [from],
          end_labels: [to],
        }),
      },
    );
    const result = await finish(database(), transcript(mention), mock.fetcher);
    assert.deepEqual(
      result.sources.map((s) => s.ref),
      [ref],
      mention,
    );
  }
});

void test('a section name alone cannot silently select Shulchan Arukh or turn Beit Yosef into the base work', async () => {
  for (const [body, expected] of [
    ['Orach Chaim siman 37.', []],
    [
      'The Beit Yosef in Orach Chaim explains it in siman 37.',
      ['Beit Yosef, Orach Chayim 37'],
    ],
  ] as const) {
    const mock = sefariaMock((text) =>
      bodyResults(text, [
        {
          mention: body.startsWith('Orach')
            ? 'Orach Chaim siman 37'
            : 'Orach Chaim explains it in siman 37',
          ref: 'Shulchan Arukh, Orach Chayim 37',
          category: 'Halakhah',
        },
      ]),
    );
    const result = await finish(database(), transcript(body), mock.fetcher);
    assert.deepEqual(
      result.sources.map((source) => source.ref),
      expected,
    );
  }
});

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
    [
      'Shabbat 2b',
      'Tosafot on Shabbat 2b',
      'Tosafot on Shabbat 2b:1',
      'Genesis 1:1',
    ],
  );
  assert.equal(result.sources[3].occurrences.length, 2);
  assert.equal(result.omitted, 0);
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

void test('named chapters, whole dapim and commentary pages are retained while missing works and locations are omitted', async () => {
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
    ['Shabbat 2', 'Tosafot on Shabbat 2b', 'Genesis 1', 'Shabbat 2b'],
  );
  assert.equal(
    result.sources[3].occurrences.length,
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
  const indexed = indexSourceHighlights(result.sources);
  for (const index of [0, 1, 2])
    assert.deepEqual(
      indexed.get(index),
      sourceHighlights(result.sources, index),
    );
  const overlap = structuredClone(result.sources[0]);
  overlap.ref = 'Overlapping reference';
  overlap.occurrences[0].spans[0].startChar++;
  const withOverlap = indexSourceHighlights([...result.sources, overlap]);
  assert.equal(withOverlap.get(0)!.length, 1);
  assert.equal(withOverlap.get(0)![0].ref, result.sources[0].ref);
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
  assert.equal(
    ready.headers.get('Cache-Control'),
    'public, max-age=60, s-maxage=300',
  );
  const uncited = await sourcesResponse(
    new Request('https://example.org/api/source-text?id=1&ref=Exodus%202%3A2'),
    dependencies,
    true,
  );
  assert.equal(uncited.status, 404);
  assert.ok(!mock.calls.some((url) => url.includes('/texts/')));
  const missing = await sourcesResponse(
    new Request('https://example.org/api/sources?id=1&refresh=1'),
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

void test('one failing reference does not discard other validated sources in the same metadata pass', async () => {
  const db = database(),
    t = transcript('Genesis 1:1. Exodus 1:1.');
  const mock = sefariaMock((body) =>
    bodyResults(body, [
      { mention: 'Genesis 1:1', ref: 'Genesis 1:1' },
      { mention: 'Exodus 1:1', ref: 'Exodus 1:1' },
    ]),
  );
  const failing: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/ref/Genesis'))
      throw new Error('temporary upstream failure');
    return mock.fetcher(input, init);
  };
  await advanceSources(db, t, failing);
  const partial = await advanceSources(db, t, failing);
  assert.equal(partial.status, 'pending');
  assert.deepEqual(
    partial.sources.map((source) => source.ref),
    ['Exodus 1:1'],
  );
  await assert.rejects(
    advanceSources(db, t, failing),
    /temporary upstream failure/,
  );
  const result = await finish(db, t, mock.fetcher);
  assert.deepEqual(
    result.sources.map((source) => source.ref),
    ['Genesis 1:1', 'Exodus 1:1'],
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
    language: 'both',
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

void test('range endpoints need their own explicit daf and amud, including the correct side', async () => {
  for (const [mention, accepted] of [
    ['Shabbat 2a-3', false],
    ['Shabbat 2-3a', false],
    ['Shabbat 2b-3a', false],
    ['Shabbat 2a-3a', true],
    ['Shabbat 2a through 3a', true],
    ['שבת ב ע״א עד ג', false],
    ['שבת ב ע״א עד ג ע״א', true],
  ] as const) {
    const ref = 'Shabbat 2a-3a';
    const mock = sefariaMock(
      (body) => bodyResults(body, [{ mention, ref, category: 'Talmud' }]),
      {
        [ref]: metadata(ref, {
          depth: 2,
          address_types: ['Talmud', 'Integer'],
          start_indexes: [3],
          end_indexes: [5],
          start_labels: ['2a'],
          end_labels: ['3a'],
        }),
      },
    );
    const result = await finish(database(), transcript(mention), mock.fetcher);
    assert.equal(result.sources.length, Number(accepted), mention);
    if (!accepted) assert.ok(result.omitted > 0);
  }
});

void test('partial commentary wording never turns a comment into a base Gemara link', async () => {
  for (const prefix of [
    "Tosfos's comment on ",
    'Rashi says in ',
    'Ramban writes on ',
    'Rashba on ',
    'Ritva in ',
    'Ran on ',
    'תוספות על ',
    'רש״י על ',
  ]) {
    const mock = sefariaMock((body) =>
      bodyResults(body, [
        { mention: 'Shabbat 2b', ref: 'Shabbat 2b', category: 'Talmud' },
      ]),
    );
    const result = await finish(
      database(),
      transcript(prefix + 'Shabbat 2b.'),
      mock.fetcher,
    );
    assert.equal(result.sources.length, 1, prefix);
    assert.equal(result.sources[0].category, 'Commentary', prefix);
    assert.ok(result.sources[0].ref.endsWith(' on Shabbat 2b'), prefix);
    assert.equal(result.omitted, 0, prefix);
  }
});

void test('omissions expose evidence and reasons once across both language models', async () => {
  const mock = sefariaMock((body) =>
    bodyResults(body, [
      { mention: 'Genesis 1', ref: 'Genesis 1' },
      { mention: 'Shabbat 2', ref: 'Shabbat 2a', category: 'Talmud' },
      { mention: 'Exodus 1:1', ref: 'Exodus 1:1', ambiguous: true },
      {
        mention: 'שם',
        ref: 'Genesis 1:1',
        debug: { ...rawDebug, context_ref: 'Genesis 1:1' },
      },
    ]),
  );
  const t = transcript('Genesis 1. Shabbat 2. Exodus 1:1. שם.');
  const result = await finish(database(), t, mock.fetcher);
  assert.deepEqual(result.omissionCounts, {
    ambiguous: 1,
    inferred: 1,
  });
  assert.deepEqual(
    result.sources.map((s) => s.ref),
    ['Genesis 1', 'Shabbat 2'],
  );
  assert.equal(result.omitted, 2);
  assert.equal(result.omissions.length, 2);
  assert.ok(result.omissions.every((o) => o.startMs === 0 && o.mention));
});

void test('Hebrew daf punctuation and numbered responsa preserve complete bibliographic locations', async () => {
  const citations = [
    { mention: 'ברכות דף מ.', ref: 'Berakhot 40a', category: 'Talmud' },
    { mention: 'שבת דף קי״ז:', ref: 'Shabbat 117b', category: 'Talmud' },
    {
      mention: 'Rivash responsum 10',
      ref: 'Teshuvot HaRivash 10',
      category: 'Responsa',
    },
  ];
  const mock = sefariaMock((body) => bodyResults(body, citations), {
    'Berakhot 40a': metadata('Berakhot 40a', {
      address_types: ['Talmud', 'Integer'],
      start_indexes: [79],
      end_indexes: [79],
    }),
    'Teshuvot HaRivash 10': metadata('Teshuvot HaRivash 10', {
      address_types: ['Siman', 'Seif'],
    }),
  });
  const result = await finish(
    database(),
    transcript(citations.map((c) => c.mention).join(' ')),
    mock.fetcher,
  );
  assert.equal(result.sources.length, 3);
});

void test('a stale worker cannot report ready or release the new owner lease', async () => {
  const db = database(),
    t = transcript('Genesis 1:1.');
  const mock = sefariaMock((body) =>
    bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
  );
  await advanceSources(db, t, mock.fetcher);
  const replacement = Date.now() + 120000;
  const stolen: typeof fetch = async (...args) => {
    await db
      .prepare('UPDATE sources_runs SET lease = ?')
      .bind(replacement)
      .run();
    return mock.fetcher(...args);
  };
  await assert.rejects(advanceSources(db, t, stolen), SourcesLeaseError);
  const row = await db
    .prepare('SELECT payload,lease FROM sources_runs')
    .first<{ payload: string; lease: number }>();
  assert.equal(row!.lease, replacement);
  assert.deepEqual(JSON.parse(row!.payload).sources, []);
  await db.prepare('UPDATE sources_runs SET lease = 0').run();
  assert.equal((await finish(db, t, mock.fetcher)).sources.length, 1);
});

void test('lease expiry alone prevents a stale save even before a replacement worker arrives', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  const db = database(),
    t = transcript('Genesis 1:1.');
  const mock = sefariaMock((body) =>
    bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
  );
  await advanceSources(db, t, mock.fetcher);
  await assert.rejects(
    advanceSources(db, t, async (...args) => {
      const response = await mock.fetcher(...args);
      now += 61000;
      return response;
    }),
    SourcesLeaseError,
  );
  assert.equal((await finish(db, t, mock.fetcher)).sources.length, 1);
});

void test('published snapshot caching checks changed revisions, corrected timings, and expiry', async (context) => {
  let now = Date.now(),
    reads = 0;
  context.mock.method(Date, 'now', () => now);
  const db = database();
  let current = transcript('Genesis 1:1.');
  const load = async () => {
    reads++;
    return structuredClone(current);
  };
  const first = await sourceSnapshot(db, '1', load);
  assert.equal(await sourceSnapshot(db, '1', load), first);
  assert.equal(reads, 1);
  current = { ...current, transcriptId: 'new-revision' };
  assert.equal(
    (await sourceSnapshot(db, '1', load, 'new-revision')).transcriptId,
    'new-revision',
  );
  assert.equal(reads, 2);
  current.segments[0].startMs = 500;
  assert.equal(
    (await sourceSnapshot(db, '1', load, null, true)).segments[0].startMs,
    500,
  );
  now += 61000;
  await sourceSnapshot(db, '1', load);
  assert.equal(reads, 4);
});

void test('source texts are durably cached by exact ref and extent; failures do not poison retries', async () => {
  const db = database();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({
      ref: 'Genesis 1:1',
      categories: ['Tanakh'],
      versions: [
        {
          versionTitle: 'Edition',
          language: 'en',
          text: Array.from({ length: 12 }, (_, i) => `Line ${i}`),
        },
      ],
    });
  };
  const excerpt = await cachedSourceText(db, 'Genesis 1:1', fetcher);
  assert.equal(excerpt.editions[0].text.length, 8);
  assert.deepEqual(await cachedSourceText(db, 'Genesis 1:1', fetcher), excerpt);
  const full = await cachedSourceText(db, 'Genesis 1:1', fetcher, 'full');
  assert.equal(full.editions[0].text.length, 12);
  assert.equal(calls, 2);
  await assert.rejects(
    cachedSourceText(db, 'Exodus 1:1', async () =>
      Response.json({ error: 'failure' }, { status: 503 }),
    ),
  );
  await assert.rejects(
    cachedSourceText(db, 'Exodus 1:1', fetcher),
    /different reference/,
  );
});

void test('HTTP polling and allowed source-text requests share one trusted transcript snapshot', async () => {
  let reads = 0;
  const mock = sefariaMock((body) =>
    bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
  );
  const dependencies = {
    db: database(),
    transcript: async () => {
      reads++;
      return Response.json(transcript('Genesis 1:1.'));
    },
    fetcher: mock.fetcher,
  };
  await sourcesResponse(
    new Request('https://example.org/api/sources?id=1'),
    dependencies,
  );
  await sourcesResponse(
    new Request('https://example.org/api/sources?id=1'),
    dependencies,
  );
  await sourcesResponse(
    new Request('https://example.org/api/source-text?id=1&ref=Exodus%201:1'),
    dependencies,
    true,
  );
  assert.equal(reads, 1);
  const changed = await sourcesResponse(
    new Request('https://example.org/api/sources?id=1&revision=stale'),
    dependencies,
  );
  assert.equal(changed.status, 409);
  assert.equal(reads, 2);
});

void test('automatic recovery backs off, respects Retry-After, and does not retry permanent errors', async () => {
  const waits: number[] = [];
  let calls = 0;
  const response = await sourceRequest(
    '/api/sources',
    new AbortController().signal,
    {
      fetcher: async () =>
        ++calls === 1
          ? Response.json({}, { status: 429, headers: { 'Retry-After': '7' } })
          : calls === 2
            ? Promise.reject(new Error('network'))
            : Response.json({}),
      wait: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(waits, [7000, 2000]);
  calls = 0;
  await assert.rejects(
    sourceRequest('/api/sources', new AbortController().signal, {
      fetcher: async () => {
        calls++;
        return Response.json({ error: 'changed' }, { status: 409 });
      },
      wait: async () => {},
    }),
    /changed/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    sourceRequest('/api/sources', new AbortController().signal, {
      fetcher: async () => {
        calls++;
        return Response.json({}, { status: 503 });
      },
      wait: async () => {},
    }),
  );
  assert.equal(calls, 5);
  assert.equal(
    sourceRetryDelay(
      'Fri, 02 Oct 2026 12:00:10 GMT',
      0,
      Date.parse('2026-10-02T12:00:00Z'),
    ),
    10000,
  );
});

void test('aborting recovery cancels the pending retry and makes no additional request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    sourceRequest('/api/sources', controller.signal, {
      fetcher: async () => {
        calls++;
        return Response.json({}, { status: 503 });
      },
      onRetry: () => controller.abort(new Error('cancelled')),
    }),
    /cancelled/,
  );
  assert.equal(calls, 1);
});

void test('server preserves Sefaria Retry-After without exposing upstream details', async () => {
  const response = await sourcesResponse(
    new Request('https://example.org/api/sources?id=1'),
    {
      db: database(),
      transcript: async () => Response.json(transcript('Genesis 1:1.')),
      fetcher: async () =>
        Response.json({}, { status: 429, headers: { 'Retry-After': '23' } }),
    },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '23');
});

void test('sheet language choices affect both preview editions and the exported document', async () => {
  const text = {
    ref: 'Genesis 1:1',
    categories: ['Tanakh'],
    editions: [
      {
        language: 'he',
        direction: 'rtl' as const,
        title: 'Hebrew edition',
        license: 'Public Domain',
        versionSource: null,
        text: ['Hebrew line'],
        truncated: false,
      },
      {
        language: 'en',
        direction: 'ltr' as const,
        title: 'English edition',
        license: 'CC-BY',
        versionSource: null,
        text: ['English line'],
        truncated: false,
      },
    ],
  };
  assert.equal(sourceEditions(text, 'both').length, 2);
  assert.deepEqual(
    sourceEditions(text).map((edition) => edition.language),
    ['he'],
  );
  assert.equal(sourceEditions(text, 'he')[0].language, 'he');
  const mock = sefariaMock((body) =>
    bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
  );
  const sources = (
    await finish(database(), transcript('Genesis 1:1'), mock.fetcher)
  ).sources;
  const html = renderSourceSheet({
    shiurId: 1,
    title: 'Sheet',
    teacher: 'Teacher',
    origin: 'https://example.org',
    sources,
    texts: { 'Genesis 1:1': text },
    limited: false,
    language: 'en',
  });
  assert.ok(html.includes('English line'));
  assert.ok(!html.includes('Hebrew line'));
  assert.ok(html.includes('English edition'));
  assert.ok(!html.includes('Hebrew edition'));
});

void test('post-publication preparation polls the shared endpoint and never fails a published transcript', async () => {
  let calls = 0;
  const events: string[] = [];
  await preparePublishedSources('1', new AbortController().signal, {
    url: 'https://example.org/api/sources/prepare',
    token: 'fixture-token',
    fetcher: async (_input, init) => {
      assert.equal(
        (init!.headers as Record<string, string>).Authorization,
        'Bearer fixture-token',
      );
      assert.deepEqual(JSON.parse(init!.body as string), { shiurId: '1' });
      return Response.json(
        { status: 'ready', transcriptId: 'fixture' },
        { status: ++calls === 1 ? 202 : 200 },
      );
    },
    wait: async () => {},
    report: (event) => events.push(event.event),
  });
  assert.deepEqual(events, ['sources_prepared']);
  await preparePublishedSources('1', new AbortController().signal, {
    url: 'https://example.org/api/sources/prepare',
    token: 'fixture-token',
    fetcher: async () => {
      throw new Error('network');
    },
    wait: async () => {},
    report: (event) => events.push(event.event),
  });
  assert.equal(events.at(-1), 'sources_preparation_deferred');
});

void test('30 published-transcript excerpts preserve precision and report measured coverage gaps', async () => {
  const report = await evaluateSourcesCorpus();
  assert.equal(report.sampleCount, 30);
  assert.equal(report.expected, 25);
  assert.equal(
    report.incorrect,
    0,
    'no source absent from the reviewed excerpt may appear',
  );
  assert.ok(
    report.accepted >= 24,
    'recognized citations and broad source references must not regress',
  );
  assert.ok(report.missed <= 1);
  assert.equal(
    report.failedSamples,
    1,
    'recorded Sefaria metadata failure remains visible',
  );
  assert.match(report.reviewedBy, /human review pending/);
});

void test('source text download limits cancel oversized upstream responses before parsing', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4_000_001));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    sourceText('Genesis 1:1', async () => response),
    /too much data/,
  );
  assert.equal(cancelled, true);
});

void test('repeat occurrence limits remain visible without duplicating or guessing citations', async () => {
  const mock = sefariaMock((body) =>
    bodyResults(body, [{ mention: 'Genesis 1:1', ref: 'Genesis 1:1' }]),
  );
  const result = await finish(
    database(),
    transcript('Genesis 1:1. '.repeat(60)),
    mock.fetcher,
  );
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].occurrences.length, 50);
  assert.equal(result.limited, true);
  assert.equal(result.omissionCounts.limit, 10);
});

void test('a failed model parse is not shown as an omission when the other model verifies those words', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/find-refs')) {
      const { text, lang } = JSON.parse(init!.body as string);
      return Response.json({
        body: bodyResults(text.body, [
          { mention: 'Genesis 1:1', ref: 'Genesis 1:1', failed: lang === 'he' },
        ]),
      });
    }
    return Response.json(metadata('Genesis 1:1'));
  };
  const result = await finish(
    database(),
    transcript('Genesis 1:1. שלום.'),
    fetcher,
  );
  assert.equal(result.sources.length, 1);
  assert.equal(result.omitted, 0);
  assert.deepEqual(result.omissions, []);
});
