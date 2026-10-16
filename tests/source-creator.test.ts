import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import {
  advanceSourceCreator,
  type SourceCreatorResult,
} from '../lib/source-creator';
import { sourceCreatorResponse } from '../lib/source-creator-handler';
import type { SourceInput } from '../lib/source-windows';
import {
  distinctiveQuote,
  quoteCandidates,
  resolveQuote,
  normalizedQuote,
} from '../lib/source-quotes';
import { sourceFeatures } from '../lib/source-features';
import { indexSourceHighlights } from '../lib/source-highlights';
import { remarkSourceLinks } from '../lib/source-note-links';
import {
  remarkNotesDirection,
  stripNotesDirectionControls,
} from '../lib/notes-direction';
import { renderSourceSheet, sourceSheetMarkdown } from '../lib/source-sheet';
import {
  emptySourceDraft,
  orderedSheetSources,
  parseSourceDraft,
  restoreSourceDraft,
} from '../lib/source-draft';
import { verifyManualSource } from '../lib/source-manual';
import { cachedSourceText } from '../lib/sources-cache';
import { sourceTextResponse } from '../lib/source-text-handler';
import type { SearchDatabase, SearchStatement } from '../lib/search-storage';
import type { RefMetadata, SourceText } from '../lib/sefaria';
import type { TranscriptSource } from '../lib/sources';
import { SourcesLeaseError } from '../lib/sources';
import { POST as verifyReferenceRequest } from '../app/api/source-creator/verify/route';

function database(): SearchDatabase {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('drizzle/0005_sources.sql', 'utf8'));
  const prepare = (sql: string, params: unknown[] = []): SearchStatement => ({
    bind: (...values) => prepare(sql, values),
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
  return {
    prepare,
    batch: async (statements) => Promise.all(statements.map((s) => s.run())),
  };
}
function metadata(ref: string): RefMetadata {
  const labels =
    ref
      .match(/\s(\d+)(?::(\d+))?$/)
      ?.slice(1)
      .filter(Boolean) || [];
  return {
    is_ref: true,
    normalized: ref,
    hebrew: 'הפניה',
    url_ref: ref.replaceAll(' ', '_').replaceAll(':', '.'),
    node_type: 'JaggedArrayNode',
    depth: 2,
    address_types: ['Perek', 'Pasuk'],
    start_indexes: labels.map(Number),
    end_indexes: labels.map(Number),
    start_labels: labels,
    end_labels: labels,
  };
}

void test('new source sheets stop before database capacity is exhausted while prepared sheets stay readable', async () => {
  const base = database();
  const constrained: SearchDatabase = {
    ...base,
    dialect: 'postgres',
    prepare(sql) {
      if (sql.includes('pg_database_size'))
        return {
          bind() {
            return this;
          },
          async first<T>() {
            // Neon counts the other databases too. The application database alone
            // still appears to have more than the required 16 MiB of headroom.
            return {
              bytes: sql.includes('current_database()') ? 512966656 : 536420752,
              maximum: 536870912,
            } as T;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async run() {
            throw new Error('Capacity checks must be read-only.');
          },
        };
      return base.prepare(sql);
    },
  };
  await assert.rejects(
    () =>
      advanceSourceCreator(constrained, input('Genesis 1:1'), mock().fetcher),
    /capacity/i,
  );
  const textOnly = await cachedSourceText(
    constrained,
    'Genesis 1:1',
    mock().fetcher,
  );
  assert.equal(textOnly.ref, 'Genesis 1:1');
  assert.equal(
    (
      await base
        .prepare('SELECT count(*) AS n FROM sources_runs')
        .first<{ n: number }>()
    )?.n,
    0,
  );
  const ready = await finish(base, input('Genesis 1:1'), mock().fetcher);
  const cached = await advanceSourceCreator(
    constrained,
    input('Genesis 1:1'),
    mock().fetcher,
  );
  assert.equal(cached.inputVersion, ready.inputVersion);
  assert.equal(cached.status, 'ready');
  const text = await cachedSourceText(base, 'Genesis 1:1', mock().fetcher);
  assert.deepEqual(
    await cachedSourceText(constrained, 'Genesis 1:1', mock().fetcher),
    text,
  );
});
const quote = 'בראשית ברא אלהים את השמים ואת הארץ והארץ היתה תהו ובהו';
void test('source storage exhaustion reports capacity instead of an interrupted check', async () => {
  for (const failure of [
    Object.assign(new Error('private database details'), { code: '53100' }),
    new SourcesLeaseError(
      'Source storage is near capacity. Retry after storage is expanded.',
    ),
  ]) {
    const response = await sourceCreatorResponse(
      new Request('https://example.test/api/source-creator?id=42'),
      {
        db: {
          ...database(),
          prepare() {
            throw failure;
          },
        },
        features: { links: true, sheets: true },
        transcript: async () => Response.json(input('Genesis 1:1').transcript),
        notes: async () => Response.json({}, { status: 404 }),
      },
    );
    assert.equal(response.status, 503);
    assert.ok(response.headers.has('Retry-After'));
    const body = await response.json();
    assert.match(body.error, /storage.*(full|capacity)/i);
    assert.doesNotMatch(body.error, /private database details/);
  }
});
function mock(
  options: {
    refs?: string[];
    text?: string;
    total?: number;
    chapter?: boolean;
    failSearch?: boolean;
    language?: 'he' | 'en';
  } = {},
) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    if (url.includes('/find-refs')) {
      const text = JSON.parse(init?.body as string).text.body as string;
      const refs: Record<string, unknown> = {};
      const results = [...text.matchAll(/Genesis\s+1:1|Exodus\s+2:2/gu)].map(
        (match) => {
          const ref = match[0].replace(/\s+/g, ' ');
          refs[ref] = { heRef: 'הפניה', url: ref, primaryCategory: 'Tanakh' };
          return {
            startChar: Array.from(text.slice(0, match.index)).length,
            endChar: Array.from(text.slice(0, match.index + match[0].length))
              .length,
            text: match[0],
            refs: [ref],
            linkFailed: false,
          };
        },
      );
      return Response.json({
        body: {
          results,
          refData: refs,
          debugData: results.map(() => [
            {
              context_ref: null,
              context_type: null,
              resolved_part_classes: ['RawRefPart'],
              orig_part_types: ['NAMED', 'NUMBERED'],
            },
          ]),
        },
      });
    }
    if (url.includes('/api/search/')) {
      if (options.failSearch) return Response.json({}, { status: 429 });
      const refs = options.refs || ['Genesis 1:1'];
      return Response.json({
        hits: {
          total: { value: options.total ?? refs.length, relation: 'eq' },
          hits: refs.map((ref) => ({ _source: { ref, exact: quote } })),
        },
      });
    }
    if (url.includes('/api/ref/')) {
      const ref = decodeURIComponent(url.split('/api/ref/')[1]);
      return Response.json(
        options.chapter ? metadata(ref.split(':')[0]) : metadata(ref),
      );
    }
    if (url.includes('/api/v3/texts/')) {
      const ref = decodeURIComponent(
        url.split('/api/v3/texts/')[1].split('?')[0],
      );
      return Response.json({
        ref,
        categories: ['Tanakh'],
        versions: [
          {
            versionTitle: 'Test edition',
            language: options.language || 'he',
            direction: options.language === 'en' ? 'ltr' : 'rtl',
            license: 'CC-BY',
            text: options.text ?? quote,
          },
        ],
      });
    }
    throw new Error(`Unexpected endpoint ${url}`);
  };
  return { fetcher, calls };
}
function input(...texts: string[]): SourceInput {
  return {
    shiurId: '42',
    transcript: {
      transcriptId: 'current',
      segments: texts.map((text, i) => ({
        text,
        startMs: i * 8000,
        endMs: (i + 1) * 8000,
      })),
    },
  };
}
async function finish(
  db: SearchDatabase,
  data: SourceInput,
  fetcher: typeof fetch,
) {
  for (let i = 0; i < 160; i++) {
    const result = await advanceSourceCreator(db, data, fetcher);
    if (result.status === 'ready') return result;
  }
  throw new Error('Source creation did not finish');
}

void test('all three detection paths share canonical sources while keeping transcript and notes evidence separate', async () => {
  const data = input('😀 See Genesis 1:1.', quote);
  data.notes = {
    markdown: 'Discuss Exodus 2:2.\n\n' + quote,
    version: 'notes-1',
  };
  const result = await finish(database(), data, mock().fetcher);
  assert.deepEqual(
    result.sources.map((s) => s.ref),
    ['Genesis 1:1', 'Exodus 2:2'],
  );
  const genesis = result.sources[0];
  assert.ok(
    genesis.occurrences.some(
      (o) => o.origin === 'transcript' && o.method === 'citation',
    ),
  );
  assert.ok(
    genesis.occurrences.some(
      (o) => o.origin === 'transcript' && o.method === 'quotation',
    ),
  );
  assert.ok(
    genesis.occurrences.some(
      (o) => o.origin === 'notes' && o.method === 'quotation',
    ),
  );
  assert.ok(
    result.sources[1].occurrences.every(
      (o) => o.origin === 'notes' && !o.spans.length,
    ),
  );
  const highlights = indexSourceHighlights(result.sources);
  assert.equal(highlights.get(0)!.length, 1);
  assert.equal(
    data.transcript!.segments[0].text.slice(
      highlights.get(0)![0].startChar,
      highlights.get(0)![0].endChar,
    ),
    'Genesis 1:1',
  );
});

void test('nearby spoken details cross segments but do not borrow a location from a long pause, distant words, or another work', async () => {
  const valid = input(
    'Shulchan Aruch in Orach Chayim, let us look inside.',
    'It says in סימן ד סעיף ד.',
  );
  const accepted = await finish(database(), valid, mock().fetcher);
  assert.equal(accepted.sources[0].ref, 'Shulchan Arukh, Orach Chayim 4:4');
  assert.ok(
    accepted.sources[0].occurrences[0].spans.some(
      (span) => span.segmentIndex === 1,
    ),
  );
  for (const data of [
    input(
      'Shulchan Aruch in Orach Chayim ' +
        'discussion '.repeat(70) +
        'siman 4 seif 4',
    ),
    input('Shulchan Aruch siman 4 seif 4'),
    input(
      'Shulchan Aruch in Orach Chayim.',
      'The Mishnah Berurah in siman 4 seif katan 4.',
    ),
    {
      ...valid,
      transcript: {
        ...valid.transcript!,
        segments: [
          valid.transcript!.segments[0],
          { ...valid.transcript!.segments[1], startMs: 90000, endMs: 98000 },
        ],
      },
    },
  ]) {
    const result = await finish(database(), data, mock().fetcher);
    assert.ok(!result.sources.some((s) => s.ref.startsWith('Shulchan Arukh,')));
  }
});

void test('common and short quotations never trigger search; Hebrew vowels and punctuation do not change verification', async () => {
  assert.equal(distinctiveQuote('אמר רבא'), false);
  assert.deepEqual(
    quoteCandidates('The teacher explains אמר רבא and continues.'),
    [],
  );
  const service = mock();
  await resolveQuote('אמר רבא', [], service.fetcher);
  assert.equal(service.calls.length, 0);
  const result = await resolveQuote(
    'בְּרֵאשִׁית ברא אלהים את השמים ואת הארץ והארץ היתה תהו ובהו',
    [],
    service.fetcher,
  );
  assert.equal(result.source?.ref, 'Genesis 1:1');
  assert.equal(normalizedQuote('אָמַר רָבָא'), 'אמר רבא');
  assert.equal(
    quoteCandidates(
      'The text says: In the beginning God created the heavens and the earth',
    ).length,
    1,
  );
});

void test('English readings cross nearby transcript cues, retain exact spans, and stop at a long pause', async () => {
  const data = input(
    'The text says: In the beginning God',
    'created the heavens and the earth',
  );
  const service = mock({
    language: 'en',
    text: 'In the beginning God created the heavens and the earth',
  });
  const result = await finish(database(), data, service.fetcher);
  const occurrence = result.sources[0]?.occurrences[0];
  assert.equal(occurrence?.method, 'quotation');
  assert.deepEqual(
    occurrence.spans.map((s) => s.segmentIndex),
    [0, 1],
  );
  for (const span of occurrence.spans)
    assert.equal(
      span.text,
      data.transcript!.segments[span.segmentIndex].text.slice(
        span.startChar,
        span.endChar,
      ),
    );
  const quoted = quoteCandidates(
    'He reads "In the beginning God\ncreated the heavens and the earth"',
  );
  assert.equal(quoted.length, 1);
  data.transcript!.segments[1].startMs = 90000;
  data.transcript!.segments[1].endMs = 98000;
  const paused = mock({ language: 'en' });
  const rejected = await finish(database(), data, paused.fetcher);
  assert.deepEqual(rejected.sources, []);
  assert.equal(
    paused.calls.filter((url) => url.includes('/api/search/')).length,
    0,
  );
});

void test('a reading spanning Sefaria segments can recover a specific segment from an exact shorter passage', async () => {
  const first = 'In the beginning God created the heaven and the earth';
  const second =
    'And the earth was without form and void and darkness was upon the face of the deep and the Spirit of God moved upon the face of the waters';
  const service = mock({ refs: ['Genesis 1:2'], text: second, language: 'en' });
  const fetcher: typeof fetch = async (url, init) => {
    const address = url instanceof Request ? url.url : url.toString();
    if (address.includes('/api/search/')) {
      const query = JSON.parse(init!.body as string).query.match_phrase.exact
        .query;
      if (!normalizedQuote(second).includes(query))
        return Response.json({ hits: { total: 0, hits: [] } });
    }
    return service.fetcher(url, init);
  };
  const result = await finish(
    database(),
    input(`He reads: "${first} ${second}"`),
    fetcher,
  );
  assert.deepEqual(
    result.sources.map((s) => s.ref),
    ['Genesis 1:2'],
  );
  assert.ok(result.sources[0].occurrences.length > 0);
  for (const occurrence of result.sources[0].occurrences)
    assert.ok(
      normalizedQuote(second).includes(normalizedQuote(occurrence.mention)),
    );
});

void test('repeated readings share verification work while retaining each recording location', async () => {
  const service = mock();
  const result = await finish(
    database(),
    input(
      quote,
      'The teacher explains this passage.',
      quote.replace('בראשית', 'בְּרֵאשִׁית'),
    ),
    service.fetcher,
  );
  assert.equal(
    service.calls.filter((url) => url.includes('/api/search/')).length,
    1,
  );
  assert.deepEqual(
    result.sources[0].occurrences
      .filter((o) => o.method === 'quotation')
      .map((o) => o.startMs),
    [0, 16000],
  );
});

void test('quotation batches are bounded and keep successful work when one request fails', async () => {
  const passages = ['ללמוד', 'לקרוא', 'לדעת', 'להבין'].map(
    (word) => `${quote} ${word}`,
  );
  const data = input(
    ...passages.flatMap((text) => [text, 'The teacher explains.']),
  );
  const service = mock({ text: passages.join('\n') });
  let active = 0,
    peak = 0,
    fail = true;
  const searched: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const address = url instanceof Request ? url.url : url.toString();
    if (!address.includes('/api/search/')) return service.fetcher(url, init);
    const query = JSON.parse(init!.body as string).query.match_phrase.exact
      .query as string;
    searched.push(query);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    if (query.endsWith('לקרוא') && fail)
      return Response.json({}, { status: 429 });
    return service.fetcher(url, init);
  };
  const db = database();
  await assert.rejects(finish(db, data, fetcher));
  assert.equal(peak, 3);
  assert.ok(!searched.some((query) => query.endsWith('להבין')));
  fail = false;
  const result = await finish(db, data, fetcher);
  assert.equal(
    result.sources[0].occurrences.filter((o) => o.method === 'quotation')
      .length,
    4,
  );
  assert.equal(searched.filter((query) => query.endsWith('ללמוד')).length, 1);
  assert.equal(searched.filter((query) => query.endsWith('לדעת')).length, 1);
  assert.equal(searched.filter((query) => query.endsWith('לקרוא')).length, 2);
});

void test('vocalized Hebrew addresses retain the original highlight text and an appended seif refines the same siman mention', async () => {
  const data = input(
    ...Array.from({ length: 33 }, (_, i) =>
      i === 29
        ? 'Shulchan Aruch'
        : i === 30
          ? 'in Orach Chayim'
          : i === 31
            ? 'סִימָן ד'
            : i === 32
              ? 'סְעִיף ד'
              : 'A short explanation.',
    ),
  );
  const result = await finish(database(), data, mock().fetcher);
  assert.deepEqual(
    result.sources.map((s) => s.ref),
    ['Shulchan Arukh, Orach Chayim 4:4'],
  );
  const spans = result.sources[0].occurrences[0].spans;
  assert.ok(spans.some((span) => span.segmentIndex === 29));
  assert.ok(spans.some((span) => span.text === 'סִימָן ד'));
  assert.ok(spans.some((span) => span.text === 'סְעִיף ד'));
});

void test('a linker default cannot choose an unspecified Shulchan Arukh section', async () => {
  const service = mock();
  const fetcher: typeof fetch = async (input, init) => {
    if (
      !(input instanceof Request ? input.url : input.toString()).includes(
        '/find-refs',
      )
    )
      return service.fetcher(input, init);
    const text = JSON.parse(init?.body as string).text.body;
    const ref = 'Shulchan Arukh, Orach Chayim 4:4';
    return Response.json({
      body: {
        results: [
          {
            startChar: 0,
            endChar: text.length,
            text,
            refs: [ref],
            linkFailed: false,
          },
        ],
        refData: {
          [ref]: { heRef: 'מקור', url: ref, primaryCategory: 'Halakhah' },
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
  };
  const result = await finish(
    database(),
    input('Shulchan Aruch siman 4 seif 4'),
    fetcher,
  );
  assert.deepEqual(result.sources, []);
  assert.equal(result.reviews[0].reason, 'missing_section');
});

void test('quote identity is based on complete global results and fetched segment text, not search rank', async () => {
  assert.equal(
    (
      await resolveQuote(
        quote,
        [],
        mock({ refs: ['Genesis 1:1', 'Genesis 1:1'] }).fetcher,
      )
    ).source?.ref,
    'Genesis 1:1',
  );
  const duplicates = mock({ refs: ['Genesis 1:1', 'Exodus 2:2'] });
  assert.equal(
    (await resolveQuote(quote, [], duplicates.fetcher)).review?.reason,
    'ambiguous_quote',
  );
  assert.equal(
    (await resolveQuote(quote, ['Genesis 1'], duplicates.fetcher)).source?.ref,
    'Genesis 1:1',
  );
  assert.equal(
    (await resolveQuote(quote, ['Genesis'], duplicates.fetcher)).review?.reason,
    'ambiguous_quote',
  );
  assert.equal(
    (await resolveQuote(quote, [], mock({ total: 80 }).fetcher)).review?.reason,
    'search_limit',
  );
  assert.equal(
    (await resolveQuote(quote, [], mock({ text: 'A different text' }).fetcher))
      .review?.reason,
    'unverified_quote',
  );
  assert.equal(
    (await resolveQuote(quote, [], mock({ chapter: true }).fetcher)).review
      ?.reason,
    'unverified_quote',
  );
  await assert.rejects(
    resolveQuote(quote, [], mock({ failSearch: true }).fetcher),
  );
});

void test('overlapping readings reuse canonical verification and populate the sheet text cache', async (t) => {
  const passages = ['ללמוד', 'לקרוא', 'לדעת', 'להבין'].map(
    (word) => `${quote} ${word}`,
  );
  const service = mock({ text: passages.join('\n') });
  const db = database();
  const started = performance.now();
  const fetcher: typeof fetch = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return service.fetcher(...args);
  };
  const result = await finish(
    db,
    input(...passages.flatMap((text) => [text, 'The teacher explains.'])),
    fetcher,
  );
  const metadataCalls = service.calls.filter((url) =>
    url.includes('/api/ref/'),
  ).length;
  const textCalls = service.calls.filter((url) =>
    url.includes('/api/v3/texts/'),
  ).length;
  t.diagnostic(
    JSON.stringify({
      elapsedMs: Math.round(performance.now() - started),
      requests: service.calls.length,
      metadataCalls,
      textCalls,
      occurrences: result.sources[0]?.occurrences.length,
    }),
  );
  assert.equal(
    metadataCalls,
    1,
    'the same canonical ref should be validated once',
  );
  assert.equal(
    textCalls,
    1,
    'the same canonical text should be downloaded once',
  );
  const sheet = await cachedSourceText(db, 'Genesis 1:1', fetcher, 'excerpt');
  assert.equal(sheet.ref, 'Genesis 1:1');
  assert.equal(
    service.calls.filter((url) => url.includes('/api/v3/texts/')).length,
    1,
    'opening the sheet should reuse the verified text',
  );
});

void test('the nearest explicit citation resolves a repeated reading without borrowing an earlier source', async () => {
  const result = await finish(
    database(),
    input('See Genesis 1:1. Now compare Exodus 2:2.', quote),
    mock({ refs: ['Genesis 1:1', 'Exodus 2:2'] }).fetcher,
  );
  assert.ok(
    result.sources
      .find((s) => s.ref === 'Exodus 2:2')
      ?.occurrences.some((o) => o.method === 'quotation'),
  );
  assert.ok(
    !result.sources
      .find((s) => s.ref === 'Genesis 1:1')
      ?.occurrences.some((o) => o.method === 'quotation'),
  );
});

void test('a distinctive short reading after introductory words retains only the verified words', async () => {
  const passage = 'בראשית ברא אלהים את השמים ואת הארץ והארץ היתה';
  const data = input('הוא מסביר לנו עכשיו וכך כתוב ' + passage);
  const service = mock({ text: passage });
  const fetcher: typeof fetch = async (url, init) => {
    const address = url instanceof Request ? url.url : url.toString();
    if (address.includes('/api/search/')) {
      const query = JSON.parse(init!.body as string).query.match_phrase.exact
        .query;
      if (!normalizedQuote(passage).includes(query))
        return Response.json({ hits: { total: 0, hits: [] } });
    }
    return service.fetcher(url, init);
  };
  const result = await finish(database(), data, fetcher);
  assert.equal(result.sources[0]?.ref, 'Genesis 1:1');
  for (const occurrence of result.sources[0].occurrences) {
    assert.ok(
      normalizedQuote(passage).includes(normalizedQuote(occurrence.mention)),
    );
    assert.ok(!occurrence.mention.includes('מסביר'));
  }
});

void test('reading cues inside a source never discard its identifying opening words', async () => {
  const passage =
    'מצות התורה היא לשמוע דברי חכמים שנאמר בראשית ברא אלהים את השמים ואת הארץ';
  const service = mock({ refs: ['Mishnah Avot 1:1'], text: passage });
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/api/search/')) {
      const query = JSON.parse(init!.body as string).query.match_phrase.exact
        .query as string;
      if (!query.startsWith('מצות'))
        return Response.json({
          hits: {
            total: 2,
            hits: [
              { _source: { ref: 'Genesis 1:1' } },
              { _source: { ref: 'Exodus 2:2' } },
            ],
          },
        });
    }
    return service.fetcher(input, init);
  };
  const result = await finish(database(), input(passage), fetcher);
  assert.ok(result.sources.some((source) => source.ref === 'Mishnah Avot 1:1'));
});

void test('a reading from another translation verifies the indexed edition instead of assuming the default wording', async () => {
  const passage = 'In the beginning God created the heaven and the earth';
  const title = 'An older translation, 1917';
  const service = mock({
    text: 'When God began to create heaven and earth',
    language: 'en',
  });
  let matchedEditionReads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.pathname.includes('/api/search/'))
      return Response.json({
        hits: {
          total: 1,
          hits: [
            {
              _source: {
                ref: 'Genesis 1:1',
                exact: passage,
                lang: 'en',
                version: title,
              },
            },
          ],
        },
      });
    if (
      url.pathname.includes('/api/v3/texts/') &&
      url.searchParams.get('version') === `english|${title}`
    ) {
      matchedEditionReads++;
      return Response.json({
        ref: 'Genesis 1:1',
        categories: ['Tanakh'],
        versions: [
          {
            versionTitle: title,
            language: 'en',
            direction: 'ltr',
            license: 'PD',
            text: passage,
          },
        ],
      });
    }
    return service.fetcher(input, init);
  };
  const result = await resolveQuote(passage, [], fetcher);
  assert.equal(result.source?.ref, 'Genesis 1:1');
  assert.equal(matchedEditionReads, 1);
  const fallback: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (
      url.pathname.includes('/api/v3/texts/') &&
      url.searchParams.get('version')?.includes('|')
    )
      return Response.json({
        ref: 'Genesis 1:1',
        categories: ['Tanakh'],
        versions: [
          {
            versionTitle: 'A silently substituted edition',
            language: 'en',
            text: passage,
          },
        ],
      });
    return fetcher(input, init);
  };
  assert.equal(
    (await resolveQuote(passage, [], fallback)).review?.reason,
    'unverified_quote',
  );
});

void test('an exact nearby segment can verify a reading without a global search, but a chapter cannot', async () => {
  const service = mock({ failSearch: true });
  const result = await resolveQuote(quote, ['Genesis 1:1'], service.fetcher);
  assert.equal(result.source?.ref, 'Genesis 1:1');
  assert.equal(result.contextual, true);
  assert.equal(
    service.calls.filter((url) => url.includes('/api/search/')).length,
    0,
  );
  await assert.rejects(
    resolveQuote(quote, ['Genesis 1'], mock({ failSearch: true }).fetcher),
  );
  const other = mock({ text: 'Another source text', refs: ['Exodus 2:2'] });
  const notCited: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/api/v3/texts/Exodus'))
      return mock().fetcher(input, init);
    return other.fetcher(input, init);
  };
  const elsewhere = await resolveQuote(quote, ['Genesis 1:1'], notCited);
  assert.equal(elsewhere.source?.ref, 'Exodus 2:2');
  assert.equal(
    elsewhere.contextual,
    false,
    'a globally unique passage must not claim support from a conflicting citation',
  );
});

void test('search count inconsistencies and unknown count precision never establish a unique reading', async () => {
  for (const total of [
    -1,
    0,
    { value: 1, relation: 'unknown' },
    { value: 1, relation: 'gte' },
  ]) {
    const service = mock();
    const result = await resolveQuote(quote, [], async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes('/api/search/'))
        return Response.json({
          hits: { total, hits: [{ _source: { ref: 'Genesis 1:1' } }] },
        });
      return service.fetcher(input, init);
    });
    assert.equal(result.source, undefined);
    assert.equal(result.review?.reason, 'search_limit');
    assert.equal(service.calls.length, 0);
  }
});

void test('sheet texts use bounded process memory, expire, and never need database access', async (t) => {
  const db = database(),
    service = mock();
  await cachedSourceText(db, 'Genesis 1:1', service.fetcher, 'full');
  service.calls.length = 0;
  const request = new Request(
    'https://example.test/api/source-creator/text?ref=Genesis%201%3A1',
  );
  const dependencies = {
    database: () => db,
    fetcher: service.fetcher,
    features: { links: true, sheets: true },
  };
  const initialTime = Date.now();
  const warm = await sourceTextResponse(request, {
    ...dependencies,
    database: () => {
      throw new Error('No database access for source text');
    },
  });
  assert.equal(warm.status, 200);
  assert.equal((await warm.json()).ref, 'Genesis 1:1');
  assert.equal(service.calls.length, 0);
  t.mock.method(Date, 'now', () => initialTime + 5 * 60000 + 1);
  assert.equal((await sourceTextResponse(request, dependencies)).status, 200);
  assert.equal(
    service.calls.filter((url) => url.includes('/api/ref/')).length,
    1,
  );
  assert.equal(
    service.calls.filter((url) => url.includes('/api/v3/texts/')).length,
    1,
  );
  service.calls.length = 0;
  assert.equal((await sourceTextResponse(request, dependencies)).status, 200);
  assert.equal(service.calls.length, 0);
  assert.equal(
    (
      await sourceTextResponse(request, {
        ...dependencies,
        features: { links: true, sheets: false },
        database: () => {
          throw new Error('Must not read storage');
        },
      })
    ).status,
    404,
  );
});

void test('simultaneous full-text and sheet requests share one download and keep excerpt limits', async () => {
  const db = database();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({
      ref: 'Genesis 1:1',
      categories: ['Tanakh'],
      versions: [
        {
          versionTitle: 'Edition',
          language: 'he',
          text: Array.from({ length: 12 }, (_, i) => `${i} ${quote}`),
        },
      ],
    });
  };
  const results = await Promise.allSettled([
    cachedSourceText(db, 'Genesis 1:1', fetcher, 'full'),
    cachedSourceText(db, 'Genesis 1:1', fetcher, 'full'),
    cachedSourceText(db, 'Genesis 1:1', fetcher, 'excerpt'),
  ]);
  for (const result of results) assert.equal(result.status, 'fulfilled');
  assert.equal(calls, 1);
  if (results[0].status === 'fulfilled' && results[2].status === 'fulfilled') {
    assert.equal(results[0].value.editions[0].text.length, 12);
    assert.equal(results[0].value.editions[0].truncated, false);
    assert.equal(results[2].value.editions[0].text.length, 8);
    assert.equal(results[2].value.editions[0].truncated, true);
  }
});

void test('appended transcripts reuse completed windows, preserve boundary references, and corrected text removes stale sources', async () => {
  const db = database(),
    service = mock();
  const data = input(
    ...Array.from({ length: 64 }, (_, i) =>
      i === 31
        ? 'See Genesis'
        : i === 32
          ? '1:1.'
          : 'A discussion of the topic.',
    ),
  );
  const first = await finish(db, data, service.fetcher);
  assert.equal(first.sources[0].ref, 'Genesis 1:1');
  assert.equal(first.sources[0].occurrences[0].spans[0].segmentIndex, 31);
  assert.equal(first.sources[0].occurrences.length, 1);
  const previousCalls = service.calls.length;
  const appended = structuredClone(data);
  appended.transcript!.segments.push({
    text: 'See Exodus 2:2.',
    startMs: 512000,
    endMs: 520000,
  });
  const second = await finish(db, appended, service.fetcher);
  assert.notEqual(first.inputVersion, second.inputVersion);
  assert.equal(second.sources.length, 2);
  assert.ok(service.calls.length - previousCalls < previousCalls);
  const corrected = input('The source was misquoted; no reference remains.');
  const third = await finish(db, corrected, service.fetcher);
  assert.deepEqual(third.sources, []);
});

void test('concurrent visitors share the creator lease and a transient quote failure can resume without losing citations', async () => {
  const db = database(),
    data = input('See Genesis 1:1. ' + quote);
  const broken = mock({ failSearch: true });
  const unavailable: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/api/v3/texts/'))
      return Response.json({}, { status: 429 });
    return broken.fetcher(input, init);
  };
  let failure = false;
  for (let i = 0; i < 8; i++) {
    try {
      await advanceSourceCreator(db, data, unavailable);
    } catch {
      failure = true;
      break;
    }
  }
  assert.equal(failure, true);
  const recovered = await finish(db, data, mock().fetcher);
  assert.ok(
    recovered.sources[0].occurrences.some((o) => o.method === 'citation'),
  );
  assert.ok(
    recovered.sources[0].occurrences.some((o) => o.method === 'quotation'),
  );
  const db2 = database(),
    service = mock();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const fetcher: typeof fetch = async (...args) => {
    calls++;
    await held;
    return service.fetcher(...args);
  };
  const one = advanceSourceCreator(db2, input('Genesis 1:1'), fetcher);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const two = await advanceSourceCreator(db2, input('Genesis 1:1'), fetcher);
  assert.equal(two.status, 'pending');
  assert.equal(calls, 1);
  release();
  await one;
});

void test('independent output flags prevent all input reads when both are off; notes work without a transcript', async () => {
  assert.deepEqual(sourceFeatures({ SOURCES_LINKS_ENABLED: 'false' }), {
    links: false,
    sheets: true,
  });
  assert.deepEqual(sourceFeatures({ SOURCES_SHEETS_ENABLED: '0' }), {
    links: true,
    sheets: false,
  });
  const url =
    'https://example.test/api/source-creator?id=42&source=official-yutorah';
  const dependencies = {
    db: database(),
    features: { links: false, sheets: false },
    transcript: async () => {
      throw new Error('Must not be called');
    },
    notes: async () => {
      throw new Error('Must not be called');
    },
  };
  assert.equal(
    (await sourceCreatorResponse(new Request(url), dependencies)).status,
    404,
  );
  const deps = {
    db: database(),
    transcript: async () => Response.json({}, { status: 404 }),
    notes: async () =>
      Response.json({
        status: 'completed',
        markdown: 'Exodus 2:2',
        notesHash: 'notes-a',
      }),
    fetcher: mock().fetcher,
  };
  let result!: SourceCreatorResult;
  for (let i = 0; i < 12; i++) {
    const response = await sourceCreatorResponse(
      new Request(url + '&text=Genesis%201:1'),
      deps,
    );
    assert.ok([200, 202].includes(response.status));
    result = await response.json();
    if (result.status === 'ready') break;
  }
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].ref, 'Exodus 2:2');
  assert.match(result.warnings[0], /transcript is unavailable/);
  assert.equal(result.sources[0].occurrences[0].origin, 'notes');
});

void test('official revision mismatch rejects stale offsets and unavailable notes do not block transcript sources', async () => {
  const deps = {
    db: database(),
    transcript: async () =>
      Response.json({
        ...input('Genesis 1:1').transcript,
        source: 'official-yutorah',
      }),
    notes: async () => Response.json({}, { status: 503 }),
    fetcher: mock().fetcher,
  };
  const stale = await sourceCreatorResponse(
    new Request('https://example.test/?id=42&revision=old'),
    deps,
  );
  assert.equal(stale.status, 409);
  const good = await sourceCreatorResponse(
    new Request(
      'https://example.test/?id=42&revision=current&source=official-yutorah',
    ),
    deps,
  );
  assert.equal(good.status, 200);
  assert.match(
    (await good.json()).warnings[0],
    /notes are temporarily unavailable/,
  );
  assert.equal(good.headers.get('Cache-Control'), 'no-store');
});

void test('expired official versions refresh the reader, transient input outages remain retryable, and growing inputs stay marked incomplete', async () => {
  const db = database(),
    service = mock();
  const missing = {
    db,
    transcript: async () => Response.json({}, { status: 404 }),
    notes: async () => Response.json({ status: 'missing', markdown: null }),
    fetcher: service.fetcher,
  };
  const expired = await sourceCreatorResponse(
    new Request(
      `https://example.test/?id=42&revision=old&version=${'a'.repeat(64)}`,
    ),
    missing,
  );
  assert.equal(expired.status, 409);
  const outage = await sourceCreatorResponse(
    new Request('https://example.test/?id=42'),
    {
      ...missing,
      transcript: async () => Response.json({}, { status: 503 }),
    },
  );
  assert.equal(outage.status, 503);
  assert.ok(outage.headers.has('Retry-After'));
  const absent = await sourceCreatorResponse(
    new Request('https://example.test/?id=42'),
    missing,
  );
  assert.equal(absent.status, 404);
  const data = input('Genesis 1:1');
  data.transcript!.complete = false;
  const result = await finish(db, data, service.fetcher);
  assert.equal(result.status, 'ready');
  assert.equal(result.transcriptComplete, false);
});

void test('notes highlighting preserves Markdown and avoids code, nested links, and invented timestamps', async () => {
  const markdown =
    '**Genesis 1:1** and [Exodus 2:2](https://example.test). `Genesis 1:1`\n\nExodus 2:2';
  const result = await finish(
    database(),
    { shiurId: '42', notes: { markdown } },
    mock().fetcher,
  );
  const html = renderToStaticMarkup(
    createElement(
      Markdown,
      {
        remarkPlugins: [
          [remarkSourceLinks, { sources: result.sources }],
          remarkNotesDirection,
        ],
      },
      stripNotesDirectionControls(markdown),
    ),
  );
  assert.match(
    html,
    /<strong><a href="https:\/\/www.sefaria.org\/Genesis.1.1">Genesis 1:1<\/a><\/strong>/,
  );
  assert.match(html, /<a href="https:\/\/example.test">Exodus 2:2<\/a>/);
  assert.match(html, /<code>Genesis 1:1<\/code>/);
  assert.equal(indexSourceHighlights(result.sources).size, 0);
});

void test('sheet drafts keep exclusions and custom order as new sources arrive; export escapes comments and respects disabled links', () => {
  const source = (ref: string): TranscriptSource => ({
    ref,
    heRef: 'מקור',
    category: 'Tanakh',
    url: `https://www.sefaria.org/${ref.replaceAll(' ', '_')}`,
    occurrences: [
      {
        origin: 'notes',
        method: 'citation',
        offset: 0,
        startMs: 0,
        endMs: 0,
        mention: ref,
        spans: [],
      },
    ],
  });
  const sources = ['Genesis 1:1', 'Exodus 2:2', 'Genesis 1:2'].map(source);
  const draft = parseSourceDraft(
    JSON.stringify({
      ...emptySourceDraft('Custom title'),
      excluded: ['Genesis 1:1'],
      order: ['Exodus 2:2'],
      introduction: '<script>alert(1)</script>',
      comments: { 'Exodus 2:2': '<img src=x>' },
      language: 'en',
    }),
    'Fallback',
  );
  const selected = orderedSheetSources(sources, draft);
  assert.deepEqual(
    selected.map((s) => s.ref),
    ['Exodus 2:2', 'Genesis 1:2'],
  );
  const text: SourceText = {
    ref: 'Exodus 2:2',
    categories: ['Tanakh'],
    editions: [
      {
        language: 'en',
        direction: 'ltr',
        title: 'An edition',
        license: 'CC-BY',
        versionSource: null,
        text: ['English passage'],
        truncated: false,
      },
      {
        language: 'he',
        direction: 'rtl',
        title: 'Hebrew edition',
        license: 'PD',
        versionSource: null,
        text: ['תורה'],
        truncated: false,
      },
    ],
  };
  const options = {
    shiurId: 42,
    title: draft.title,
    teacher: 'Teacher',
    origin: 'https://example.test',
    sources: selected,
    texts: { 'Exodus 2:2': text },
    limited: false,
    includeLinks: false,
    introduction: draft.introduction,
    comments: draft.comments,
    language: draft.language,
    incomplete: true,
  };
  const html = renderSourceSheet(options),
    md = sourceSheetMarkdown(options);
  assert.doesNotMatch(
    html,
    /href="https:\/\/www.sefaria.org|Mentioned at|<script>|<img/,
  );
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /Published notes|CC-BY|An edition/);
  assert.doesNotMatch(html, /partial sheet|<footer/);
  assert.match(md, /Custom title/);
  assert.match(md, /English passage/);
  assert.doesNotMatch(md, /Hebrew edition|\]\(https:\/\/www.sefaria.org/);
  const hebrew = { ...options, language: undefined };
  assert.match(renderSourceSheet(hebrew), /תורה/);
  assert.doesNotMatch(renderSourceSheet(hebrew), /English passage/);
  assert.doesNotMatch(sourceSheetMarkdown(hebrew), /English passage/);
  assert.deepEqual(
    parseSourceDraft('{bad', 'Fallback'),
    emptySourceDraft('Fallback'),
  );
});

void test('sheets open in Hebrew and migrate old edits without keeping the old bilingual default', () => {
  assert.equal(emptySourceDraft('Sheet').language, 'he');
  const saved = JSON.stringify({
    title: 'My title',
    language: 'both',
    excluded: ['Genesis 1:1'],
    manualRefs: ['Exodus 2:2'],
    comments: { 'Exodus 2:2': 'My note' },
  });
  const migrated = restoreSourceDraft(null, saved, 'Fallback');
  assert.equal(migrated.language, 'he');
  assert.equal(migrated.title, 'My title');
  assert.deepEqual(migrated.excluded, ['Genesis 1:1']);
  assert.deepEqual(migrated.manualRefs, ['Exodus 2:2']);
  assert.equal(migrated.comments['Exodus 2:2'], 'My note');
  assert.equal(restoreSourceDraft(saved, null, 'Fallback').language, 'both');
  assert.equal(restoreSourceDraft('{bad', saved, 'Fallback').language, 'he');
});

void test('manual corrections require a valid numbered Sefaria reference and remain labeled as user additions', async () => {
  assert.equal(await verifyManualSource('Genesis', mock().fetcher), null);
  assert.equal(await verifyManualSource('<script>', mock().fetcher), null);
  const source = await verifyManualSource('Genesis 1:1', mock().fetcher);
  assert.equal(source?.ref, 'Genesis 1:1');
  assert.equal(source?.occurrences[0].origin, 'manual');
});

void test('manual verification bounds request bytes before parsing and rejects malformed input without a Sefaria request', async () => {
  const request = (body: string) =>
    new Request('https://example.test/api/source-creator/verify', {
      method: 'POST',
      body,
    });
  assert.equal(
    (await verifyReferenceRequest(request('x'.repeat(2049)))).status,
    413,
  );
  assert.equal(
    (await verifyReferenceRequest(request('א'.repeat(1100)))).status,
    413,
  );
  assert.equal((await verifyReferenceRequest(request('{bad'))).status, 400);
  assert.equal(
    (await verifyReferenceRequest(request('{"ref":false}'))).status,
    400,
  );
});

void test('durable records contain only references and operational metadata, including after a cold restart', async () => {
  const db = database();
  const data = input('See Genesis 1:1. ' + quote);
  data.notes = {
    markdown: 'Private note wording. Exodus 2:2.',
    version: 'notes-1',
  };
  data.description = 'Private description wording. Genesis 1:1.';
  const service = mock();
  const first = await finish(db, data, service.fetcher);
  assert.equal(first.sources.length, 2);
  const rows = await db
    .prepare('SELECT id,payload FROM sources_runs')
    .all<{ id: string; payload: string }>();
  for (const row of rows.results) {
    const stored = JSON.parse(row.payload);
    assert.doesNotMatch(
      row.payload,
      /Private|בראשית|mention|spans|startMs|endMs|editions|verification|heRef|occurrences/,
    );
    assert.ok(!row.id.startsWith('text:'));
    assert.ok(!stored.segments && !stored.markdown && !stored.description);
    if (row.id.startsWith('prepared:')) {
      assert.deepEqual(Object.keys(stored).sort(), ['inputVersion', 'refs']);
      assert.deepEqual(stored.refs, ['Genesis 1:1', 'Exodus 2:2']);
      assert.ok(Buffer.byteLength(row.payload) < 150);
    }
  }
  // A new database adapter has no process-local detection evidence.
  const cold = await advanceSourceCreator({ ...db }, data, async () => {
    throw new Error('Prepared references must not require Sefaria');
  });
  assert.equal(cold.status, 'ready');
  assert.deepEqual(
    cold.sources.map((s) => s.ref),
    ['Genesis 1:1', 'Exodus 2:2'],
  );
  assert.ok(
    cold.sources.every(
      (s) =>
        s.occurrences.length === 0 &&
        s.url.startsWith('https://www.sefaria.org/'),
    ),
  );
});

void test('description-only shiurim are checked, and changed descriptions replace stale references', async () => {
  const db = database(),
    service = mock();
  let description = 'See Genesis 1:1.';
  const request = new Request('https://example.test/api/source-creator?id=42');
  const dependencies = {
    db,
    fetcher: service.fetcher,
    features: { links: true, sheets: true },
    transcript: async () => Response.json({}, { status: 404 }),
    notes: async () => Response.json({}, { status: 404 }),
    description: async () => Response.json({ description }),
  };
  const finishRequest = async () => {
    for (let n = 0; n < 20; n++) {
      const response = await sourceCreatorResponse(request, dependencies);
      assert.ok(response.status === 200 || response.status === 202);
      const result = (await response.json()) as SourceCreatorResult;
      if (response.status === 200) return result;
    }
    throw new Error('Description checking did not finish');
  };
  const first = await finishRequest();
  assert.deepEqual(
    first.sources.map((s) => s.ref),
    ['Genesis 1:1'],
  );
  assert.ok(
    first.sources[0].occurrences.every(
      (o) => o.origin === 'description' && !o.spans.length && !o.noteSpans,
    ),
  );
  description = 'Corrected source list: Exodus 2:2.';
  const changed = await finishRequest();
  assert.notEqual(changed.inputVersion, first.inputVersion);
  assert.deepEqual(
    changed.sources.map((s) => s.ref),
    ['Exodus 2:2'],
  );
});

void test('pending Sefaria tasks survive process loss without saving source positions or resubmitting text', async () => {
  const db = database(),
    data = input('See Genesis 1:1.'),
    service = mock();
  let submissions = 0,
    polls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const address = url instanceof Request ? url.url : url.toString();
    if (address.includes('/api/find-refs')) {
      submissions++;
      return Response.json({ task_id: 'source-task-1' });
    }
    if (address.includes('/api/async/')) {
      polls++;
      if (polls < 2) return Response.json({ state: 'PENDING', ready: false });
      return service.fetcher('https://www.sefaria.org/api/find-refs', {
        method: 'POST',
        body: JSON.stringify({
          text: { body: data.transcript!.segments[0].text },
        }),
      });
    }
    return service.fetcher(url, init);
  };
  let result = await advanceSourceCreator({ ...db }, data, fetcher);
  assert.equal(result.status, 'pending');
  for (let n = 0; n < 10 && result.status !== 'ready'; n++)
    result = await advanceSourceCreator({ ...db }, data, fetcher);
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.sources.map((s) => s.ref),
    ['Genesis 1:1'],
  );
  assert.equal(submissions, 1);
  assert.ok(polls >= 2);
});

void test('a temporary description outage cannot overwrite a fully prepared reference list', async () => {
  const db = database(),
    data = input('Genesis 1:1'),
    service = mock();
  data.description = 'Exodus 2:2';
  await finish(db, data, service.fetcher);
  const before = await db
    .prepare("SELECT payload FROM sources_runs WHERE id LIKE 'prepared:%'")
    .first<{ payload: string }>();
  const partial = input('Genesis 1:1');
  partial.retryable = true;
  await finish(db, partial, service.fetcher);
  const after = await db
    .prepare("SELECT payload FROM sources_runs WHERE id LIKE 'prepared:%'")
    .first<{ payload: string }>();
  assert.equal(after!.payload, before!.payload);
});

void test(
  'reference-only creator and cleanup work on PostgreSQL across fresh database adapters',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const { Pool } = await import('pg');
    const { postgresSearchDatabase } = await import('../lib/search-postgres');
    const { migrateSourcesSchema } =
      await import('../scripts/migrate-search-schema');
    const { pruneSourceCache } = await import('../lib/sources-cache');
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = 'source_refs_' + crypto.randomUUID().replaceAll('-', '');
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      const db = postgresSearchDatabase(pool, schema);
      await migrateSourcesSchema(db);
      const data: SourceInput = {
        shiurId: '42',
        description: 'See Genesis 1:1.',
      };
      const service = mock();
      await finish(db, data, service.fetcher);
      const cold = await advanceSourceCreator(
        postgresSearchDatabase(pool, schema),
        data,
        async () => {
          throw new Error('A saved reference must need no upstream request');
        },
      );
      assert.deepEqual(
        cold.sources.map((s) => s.ref),
        ['Genesis 1:1'],
      );
      await db
        .prepare(
          'INSERT INTO sources_runs(id,payload,lease,expires) VALUES(?,?,0,?)',
        )
        .bind(
          'text:legacy',
          JSON.stringify({ editions: [{ text: ['legacy text'] }] }),
          Date.now() + 86400000,
        )
        .run();
      await pruneSourceCache(db);
      const rows = await db
        .prepare('SELECT id,payload FROM sources_runs')
        .all<{ id: string; payload: string }>();
      assert.ok(!rows.results.some((r) => r.id.startsWith('text:')));
      assert.ok(
        rows.results.some((r) => r.id.startsWith('prepared:creator-v5:')),
      );
      assert.ok(
        rows.results.every(
          (r) => !/mention|spans|editions|occurrences/.test(r.payload),
        ),
      );
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  },
);
