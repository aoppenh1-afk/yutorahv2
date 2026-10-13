import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  parseSearch,
  matchesPlan,
  dateBoundary,
  type Directory,
} from '../lib/yutorah';
import {
  legacySearchLink,
  nativeYutorahLink,
  resolveEntitySlug,
} from '../lib/legacy-links';
import { normalizeOfficialStudy } from '../lib/official-study';
import {
  archiveSearchParameters,
  catalogFacets,
  readArchiveSearch,
} from '../lib/catalog';
import { resolvedSearchFilters } from '../lib/search-filters';
import { feedbackLink } from '../lib/feedback';

void test('original URLs preserve every entity restriction, query, and uploaded range', () => {
  const link = new URL(
    legacySearchLink({
      s: 'meat & milk',
      teacher: '80714,80153',
      category: '0,234055',
      series: '4000',
      location: '439',
      collection: '15353',
      publicationid: '247',
      publicationvolumeid: '444',
      dtu: '2026-10-01,2026-10-13',
    }),
    'https://example.test',
  );
  assert.equal(link.searchParams.get('q'), 'meat & milk');
  assert.deepEqual(
    Object.fromEntries(
      [
        'teacher',
        'topic',
        'series',
        'venue',
        'collection',
        'publication',
        'volume',
        'after',
        'before',
        'dateBasis',
      ].map((k) => [k, link.searchParams.get(k)]),
    ),
    {
      teacher: '80714,80153',
      topic: '234055',
      series: '4000',
      venue: '439',
      collection: '15353',
      publication: '247',
      volume: '444',
      after: '2026-10-01',
      before: '2026-10-13',
      dateBasis: 'uploaded',
    },
  );
});
void test('simultaneous original upload and lecture ranges both survive', () => {
  const p = new URL(
    legacySearchLink({
      dtu: '2026-10-01,2026-10-13',
      dtg: '2011-01-01,2011-12-31',
    }),
    'https://example.test',
  ).searchParams;
  assert.equal(p.get('uploadedAfter'), '2026-10-01');
  assert.equal(p.get('uploadedBefore'), '2026-10-13');
  assert.equal(p.get('after'), '2011-01-01');
  assert.equal(p.get('before'), '2011-12-31');
  assert.equal(p.get('dateBasis'), 'given');
});

void test('profile slug resolution uses subject hierarchy and does not guess ambiguous names', () => {
  const d = {
    teachers: [],
    series: [],
    groups: [],
    topics: [
      { id: 1, name: 'General', group: 'Gemara', count: 1 },
      { id: 2, name: 'General', group: 'Halacha', count: 1 },
    ],
  } as Directory;
  assert.equal(resolveEntitySlug('topic', ['Gemara', 'General'], d), 1);
  assert.equal(resolveEntitySlug('topic', ['General'], d), undefined);
});
void test('all authors, course position and category identity survive normalization', () => {
  const s = normalize({
    shiurid: 77,
    teacherfullname: ['One', 'Two', 'Three'],
    teacherid: [1, 2, 3],
    subcategoryname: ['Kashrut'],
    subcategoryid: [10],
    categoryname: ['Halacha'],
    collectionid: [123],
    collectionname: ['Course|123|7'],
    locationid: [439],
    publicationid: [247],
    publicationname: ['Journal'],
  });
  assert.deepEqual(
    s.speakers?.map((t) => t.id),
    [1, 2, 3],
  );
  assert.equal(s.collections?.[0].position, 7);
  assert.deepEqual(
    s.facets?.filter((f) => f.kind === 'teachers').map((f) => f.id),
    [1, 2, 3],
  );
  assert.equal(s.topicPaths?.[0].group, 'Halacha');
});
void test('mobile article details use a volume key without inventing a publication ID', () => {
  const s = normalize({ shiurID: 1, shiurPublication: 20474 });
  assert.equal(s.volumeId, 20474);
  assert.equal(s.publicationId, undefined);
});

void test('recent uploads include old lectures and lecture-date searches exclude them', () => {
  const s = normalize({
    shiurid: 1,
    shiurdate: '2011-01-01',
    shiurdatesubmitted: '2026-10-12T17:00:00Z',
  });
  const uploaded = parseSearch('', {
    after: '2026-10-12',
    before: '2026-10-12',
    dateBasis: 'uploaded',
  });
  assert.ok(matchesPlan(s, uploaded));
  assert.ok(!matchesPlan(s, { ...uploaded, dateBasis: 'given' }));
});
void test('chapter metadata ignores quizzes and rejects invalid seek ranges', () => {
  const d = normalizeOfficialStudy(77, {
    Summary: 'A summary',
    Quiz: { secret: 'excluded' },
    Chapters: [
      { title: 'Later', summary: 'Two', start_seconds: 10, end_seconds: 20 },
      { title: 'Start', summary: 'One', start_seconds: 0, end_seconds: 10 },
      { title: 'Bad', start_seconds: -1, end_seconds: 2 },
      { title: 'Bad', start_seconds: 8, end_seconds: 2 },
    ],
  });
  assert.deepEqual(
    d.chapters.map((c) => c.title),
    ['Start', 'Later'],
  );
  assert.equal('Quiz' in d, false);
  assert.equal(normalizeOfficialStudy(77, null).available, false);
});
void test('publication requests preserve OR selections and resolve back to the same filters', () => {
  const plan = parseSearch('', {
    publicationId: 247,
    volumeId: 444,
    entityIds: { teacher: [1, 2], publication: [247], volume: [444] },
  });
  const p = archiveSearchParameters(plan, 'waiting', 2);
  assert.match(p.get('facet_query')!, /teacherid:\(1 OR 2\)/);
  assert.match(
    p.get('facet_query')!,
    /publicationid:247,publicationvolumeid:444/,
  );
  assert.equal(resolvedSearchFilters(plan).teacher, '1,2');
});
void test('website publication pages are adapted to thirty-record scanner pages without gaps', async (t) => {
  const docs = Array.from({ length: 75 }, (_, i) => ({ shiurid: i + 1 }));
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const page = Number(
      new URL(input instanceof Request ? input.url : input).searchParams.get(
        'page',
      ),
    );
    return Response.json({
      response: { docs: docs.slice((page - 1) * 25, page * 25), numFound: 75 },
    });
  });
  const plan = parseSearch('', { publicationId: 999 });
  const ids: number[] = [];
  for (let page = 1; page <= 3; page++)
    ids.push(
      ...(
        await readArchiveSearch(plan, 'unique-page-fixture', page)
      ).response.docs.map((s) => s.shiurid!),
    );
  assert.deepEqual(
    ids,
    docs.map((s) => s.shiurid),
  );
});
void test('facets retain publication volumes and original campaign links become native courses', () => {
  assert.deepEqual(
    catalogFacets({ publicationVolumes: ['Journal', 'Vol 1', 5, 9] }).volumes,
    [{ id: 5, name: 'Vol 1', count: 9 }],
  );
  assert.equal(
    nativeYutorahLink('https://www.yutorah.org/search/?collection=15353'),
    '/?view=collection&kind=collection&id=15353',
  );
  assert.equal(nativeYutorahLink('javascript:alert(1)'), '');
});
void test('content reports contain shiur context and route separately from interface feedback', () => {
  const s = {
    id: 77,
    title: 'Title',
    url: 'https://yutorah.org/lectures/details?shiurID=77',
  };
  const content = new URL(
    feedbackLink('content', 'Wrong file', 'https://example.test/?shiur=77', s),
  );
  assert.equal(content.pathname, 'errors@yutorah.org');
  assert.match(content.searchParams.get('body')!, /Shiur ID: 77/);
  assert.equal(
    new URL(feedbackLink('interface', 'Layout issue', 'https://example.test/'))
      .pathname,
    'yutorahv2@gmail.com',
  );
});

void test('uploaded day bounds include the full New York day through daylight saving', () => {
  assert.equal(dateBoundary('2026-11-01', true), '2026-11-01T04:00:00.000Z');
  assert.equal(
    dateBoundary('2026-11-01', true, true),
    '2026-11-02T05:00:00.000Z',
  );
  const plan = parseSearch('', {
    dateBasis: 'uploaded',
    after: '2026-10-12',
    before: '2026-10-12',
  });
  assert.ok(
    matchesPlan(
      normalize({ shiurid: 1, shiurdatesubmitted: '2026-10-13T03:59:59Z' }),
      plan,
    ),
  );
  assert.ok(
    !matchesPlan(
      normalize({ shiurid: 1, shiurdatesubmitted: '2026-10-12T03:59:59Z' }),
      plan,
    ),
  );
});
