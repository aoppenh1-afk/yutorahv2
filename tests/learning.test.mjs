import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
async function load(path) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}
const {
  defaultLearning,
  restoreLearning,
  recommend,
  recommendationAnchor,
  recommendationSources,
  relatedShiurim,
  followsShiur,
  learningStats,
  dayKey,
  isLearned,
  mergeShiurim,
} = await load('lib/learning.ts');
const shiur = (id, overrides = {}) => ({
  id,
  title: 'Shabbat ' + id,
  teacherId: id,
  teacher: 'Teacher ' + id,
  image: '',
  audio: 'https://example.org/shiur.mp3',
  url: '',
  date: '2026-09-16',
  duration: 900,
  topics: ['Shabbat'],
  category: 'Halacha',
  language: 'EN',
  seriesId: 0,
  series: '',
  description: '',
  format: 'mp3',
  materials: [],
  ...overrides,
});
const context = (overrides = {}) => ({
  ...defaultLearning,
  saved: [],
  history: [],
  ...overrides,
});
void test('existing libraries migrate without inventing learning or follows', () => {
  const restored = restoreLearning({ saved: [shiur(1)] });
  assert.deepEqual(restored.following, []);
  assert.deepEqual(restored.learningDays, {});
  assert.equal(restored.dailyGoal, 20);
});
void test('malformed persisted preferences are discarded without erasing valid entries', () => {
  const restored = restoreLearning({
    following: [
      null,
      { kind: 'teacher', id: 4, name: 'Teacher' },
      { kind: 'teacher', id: -1, name: '' },
    ],
    hidden: [null, 2, 2, '3'],
    completed: {},
    savedSearches: [
      null,
      { id: '1', name: 'A search', query: 'Shabbat', filters: { max: '20' } },
    ],
    dailyGoal: -50,
    learningDays: { '2026-09-16': 60, secret: 8, '2026-09-15': -4 },
  });
  assert.equal(restored.following.length, 1);
  assert.deepEqual(restored.hidden, [2]);
  assert.deepEqual(restored.completed, []);
  assert.equal(restored.savedSearches.length, 1);
  assert.deepEqual(restored.learningDays, { '2026-09-16': 60 });
});
void test('followed teachers outrank unrelated teachers and carry an explanation', () => {
  const output = recommend(
    [shiur(1), shiur(2)],
    context({ following: [{ kind: 'teacher', id: 2, name: 'Teacher 2' }] }),
  );
  assert.equal(output[0].shiur.id, 2);
  assert.match(output[0].reason, /follow/);
});
void test('following feed excludes non-followed records and supports topics and series', () => {
  const library = context({
    following: [
      { kind: 'topic', id: 10, name: 'Shabbat' },
      { kind: 'series', id: 20, name: 'Series' },
    ],
  });
  const output = recommend(
    [
      shiur(1),
      shiur(2, { topics: [], category: '', seriesId: 20 }),
      shiur(3, { topics: ['Tefillah'] }),
    ],
    library,
    { followingOnly: true },
  );
  assert.deepEqual(output.map((r) => r.shiur.id).sort(), [1, 2]);
  assert.equal(followsShiur(shiur(4), { kind: 'teacher', id: 9 }), false);
});
void test('Following shows newest uploads first instead of personal ranking or teacher variety', () => {
  const library = context({
    following: [{ kind: 'teacher', id: 50, name: 'Teacher' }],
    saved: [shiur(9, { teacherId: 50, seriesId: 20, series: 'Shabbat' })],
    hidden: [4],
    completed: [5],
  });
  const result = recommend(
    [
      shiur(1, {
        teacherId: 50,
        seriesId: 20,
        series: 'Shabbat',
        date: '2026-09-01',
      }),
      shiur(2, { teacherId: 50, topics: [], date: '2026-10-02' }),
      shiur(3, { teacherId: 50, date: '2020-01-01', uploadedAt: '2026-10-03' }),
      shiur(4, { teacherId: 50, date: '2026-10-04' }),
      shiur(5, { teacherId: 50, date: '2026-10-05' }),
      shiur(6, { teacherId: 60, date: '2026-10-06' }),
    ],
    library,
    { followingOnly: true },
  );
  assert.deepEqual(
    result.map((r) => r.shiur.id),
    [3, 2, 1],
  );
});
void test('hidden, completed and almost-finished shiurim are removed; unknown duration never meets a time budget', () => {
  const library = context({
    hidden: [1],
    completed: [2],
    history: [{ shiur: shiur(3), seconds: 880, duration: 900 }],
  });
  const output = recommend(
    [
      shiur(1),
      shiur(2),
      shiur(3),
      shiur(4, { duration: 0 }),
      shiur(5, { duration: 1200 }),
      shiur(6),
    ],
    library,
    { minutes: 15 },
  );
  assert.deepEqual(
    output.map((r) => r.shiur.id),
    [6],
  );
  assert.equal(isLearned(shiur(3), library), true);
});
void test('recommendations deduplicate and retain richer metadata', () => {
  const items = [
    shiur(1, { seriesId: 88, series: 'Series' }),
    shiur(1, { duration: 0, audio: '', topics: [] }),
  ];
  const merged = mergeShiurim(items);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].duration, 900);
  assert.equal(merged[0].seriesId, 88);
  assert.deepEqual(merged[0].topics, ['Shabbat']);
  assert.equal(recommend(items, context(), { minutes: 15 }).length, 1);
});
void test('similarly relevant recommendations include a variety of teachers', () => {
  const items = [
    shiur(1, { teacherId: 50 }),
    shiur(2, { teacherId: 50 }),
    shiur(3, { teacherId: 50 }),
    shiur(4),
    shiur(5),
  ];
  const output = recommend(
    items,
    context({
      following: [50, 4, 5].map((id) => ({
        kind: 'teacher',
        id,
        name: 'Teacher ' + id,
      })),
    }),
  );
  assert.notEqual(output[0].shiur.teacherId, output[1].shiur.teacherId);
});
void test('teacher variety never promotes unrelated recordings ahead of strong matches', () => {
  const output = recommend(
    [shiur(1, { teacherId: 50 }), shiur(2, { teacherId: 50 }), shiur(3)],
    context({ following: [{ kind: 'teacher', id: 50, name: 'Teacher' }] }),
  );
  assert.deepEqual(
    output.map((r) => r.shiur.teacherId),
    [50, 50, 3],
  );
  const topicOnly = recommend(
    [
      shiur(1, { teacherId: 50 }),
      shiur(2, { teacherId: 50 }),
      shiur(3, { topics: ['Tefillah'] }),
    ],
    context({ saved: [shiur(9)] }),
  );
  assert.deepEqual(
    topicOnly.map((r) => r.shiur.id),
    [2, 1, 3],
  );
});
void test('accidental plays and hidden interests do not influence ranking or fetched sources', () => {
  const library = context({
    history: [
      {
        shiur: shiur(10, { teacherId: 50, seriesId: 20 }),
        seconds: 3,
        duration: 900,
      },
    ],
    saved: [shiur(11, { teacherId: 50 })],
    hidden: [11],
  });
  const output = recommend([shiur(1, { teacherId: 50 }), shiur(2)], library);
  assert.deepEqual(
    output.map((r) => r.shiur.id),
    [2, 1],
  );
  assert.ok(output.every((r) => r.reason === 'From the YUTorah library'));
  assert.deepEqual(recommendationSources(library), []);
  assert.equal(recommendationAnchor(library), undefined);
});
void test('sustained and repeated learning outweighs a single sampled teacher', () => {
  const library = context({
    history: [
      {
        shiur: shiur(10, { teacherId: 60, topics: [] }),
        seconds: 90,
        duration: 900,
      },
      {
        shiur: shiur(11, { teacherId: 50, topics: [] }),
        seconds: 800,
        duration: 900,
      },
      {
        shiur: shiur(12, { teacherId: 50, topics: [] }),
        seconds: 800,
        duration: 900,
      },
    ],
  });
  const output = recommend(
    [shiur(1, { teacherId: 60 }), shiur(2, { teacherId: 50 })],
    library,
  );
  assert.equal(output[0].shiur.teacherId, 50);
  assert.equal(recommendationSources(library)[0].id, 50);
  assert.equal(recommendationAnchor(library).id, 11);
});
void test('topic identity connects sparse metadata and distinguishes same-name topics', () => {
  const output = recommend(
    [
      shiur(1, { topics: ['Other label'], topicIds: [100] }),
      shiur(2, { topics: ['Shabbat'], topicIds: [200] }),
    ],
    context({ saved: [shiur(9, { topicIds: [100] })] }),
  );
  assert.equal(output[0].shiur.id, 1);
  assert.equal(output[0].reason, 'Because you explore Other label');
  assert.equal(output[1].reason, 'From the YUTorah library');
});
void test('saved-only interests fetch teachers, specific series and topics within the source budget', () => {
  const saved = shiur(9, {
    seriesId: 20,
    series: 'Shabbat in Depth',
    topicIds: [100],
  });
  const sources = recommendationSources(context({ saved: [saved] }));
  assert.deepEqual(
    sources.map(({ kind, id }) => [kind, id]),
    [
      ['teacher', 9],
      ['series', 20],
      ['topic', 100],
    ],
  );
  const follows = Array.from({ length: 12 }, (_, i) => ({
    kind: 'teacher',
    id: i + 1,
    name: 'Teacher',
  }));
  const bounded = recommendationSources(
    context({ following: follows, saved: [saved] }),
  );
  assert.equal(bounded.length, 8);
  assert.ok(bounded.some((f) => f.kind === 'series' && f.id === 20));
  assert.ok(bounded.some((f) => f.kind === 'topic' && f.id === 100));
  assert.equal(new Set(bounded.map((f) => f.kind + ':' + f.id)).size, 8);
  assert.deepEqual(
    recommendationSources(context({ following: follows })),
    follows.slice(0, 8),
  );
});
void test('generic series and duplicate listening records do not inflate interests', () => {
  const source = shiur(9, { seriesId: 20, series: 'Daily Shiur' });
  const history = { shiur: source, seconds: 900, duration: 900 };
  const single = context({ history: [history] });
  const options = { now: Date.parse('2026-10-15') };
  assert.deepEqual(
    recommend([shiur(1)], context({ history: [history, history] }), options),
    recommend([shiur(1)], single, options),
  );
  assert.ok(recommendationSources(single).every((f) => f.kind !== 'series'));
});
const unclassified = (id, overrides = {}) =>
  shiur(id, {
    title: 'Recording ' + id,
    topics: [],
    category: '',
    topicIds: [],
    ...overrides,
  });
void test('collections match by identity, explain the connection, and do not double count membership', () => {
  const collection = { id: 40, name: 'Practical Kashrut' };
  const library = context({
    saved: [unclassified(9, { collections: [collection] })],
  });
  const matched = unclassified(1, { collections: [collection] });
  const options = { now: Date.parse('2026-10-15') };
  const output = recommend(
    [unclassified(2, { collections: [{ ...collection, id: 41 }] }), matched],
    library,
    options,
  );
  assert.equal(output[0].shiur.id, 1);
  assert.equal(output[0].reason, 'More from Practical Kashrut');
  assert.equal(output[1].reason, 'From the YUTorah library');
  assert.equal(
    recommend(
      [{ ...matched, collections: [collection, collection] }],
      library,
      options,
    )[0].score,
    output[0].score,
  );
});
void test('a matching series and collection outweigh a teacher follow alone', () => {
  const collection = { id: 40, name: 'Practical Kashrut' };
  const shared = {
    seriesId: 20,
    series: 'Kitchen Questions',
    collections: [collection],
  };
  const library = context({
    following: [{ kind: 'teacher', id: 50, name: 'Teacher' }],
    saved: [unclassified(9, { ...shared, teacherId: 50 })],
  });
  const output = recommend(
    [
      unclassified(1, { ...shared, teacherId: 80 }),
      unclassified(2, { teacherId: 50 }),
    ],
    library,
  );
  assert.equal(output[0].shiur.id, 1);
  assert.equal(output[0].reason, 'More in Kitchen Questions');
});
void test('title subjects connect related learning across spellings and languages', () => {
  for (const [source, title] of [
    ['Shabbat Candle Lighting', 'Shabbos Candles: Lighting at Home'],
    ['קידוש שבת', 'Shabbos Kiddush'],
  ]) {
    const output = recommend(
      [
        unclassified(1, { title }),
        unclassified(2, { title: 'Charity and Community' }),
      ],
      context({ saved: [unclassified(9, { title: source })] }),
    );
    assert.equal(output[0].shiur.id, 1, source);
    assert.equal(output[0].reason, `Similar to "${source}"`);
    assert.equal(output[1].reason, 'From the YUTorah library');
  }
});
void test('title boilerplate, numbers, speaker names and one shared word do not create interests', () => {
  const source = unclassified(9, {
    title: 'Weekly Torah Shiur Part 2 by Rabbi Example Name',
    teacher: 'Rabbi Example Name',
  });
  const items = [
    unclassified(1, {
      title: 'Weekly Torah Shiur Part 2 by Rabbi Example Name',
    }),
  ];
  assert.equal(
    recommend(items, context({ saved: [source] }))[0].reason,
    'From the YUTorah library',
  );
  const singleWord = recommend(
    [unclassified(1, { title: 'Shabbos Family Customs' })],
    context({ saved: [unclassified(9, { title: 'Shabbat Candle Lighting' })] }),
  );
  assert.equal(singleWord[0].reason, 'From the YUTorah library');
});
void test('all named speakers contribute to teacher matches and fetched candidates', () => {
  const source = unclassified(9, {
    speakers: [{ id: 50, name: 'Co-teacher' }],
  });
  const library = context({ saved: [source] });
  const output = recommend(
    [unclassified(1, { teacherId: 50 }), unclassified(2)],
    library,
  );
  assert.equal(output[0].shiur.id, 1);
  assert.equal(output[0].reason, 'From a teacher you learn with');
  assert.ok(
    recommendationSources(library).some(
      (s) => s.kind === 'teacher' && s.id === 50,
    ),
  );
});
void test('candidate fetching reserves space for series and collections alongside teachers and topics', () => {
  const shared = {
    seriesId: 20,
    series: 'Kitchen Questions',
    collections: [{ id: 40, name: 'Kashrut' }],
    topicIds: [100],
  };
  const library = context({
    following: Array.from({ length: 10 }, (_, i) => ({
      kind: 'teacher',
      id: i + 1,
      name: 'Teacher',
    })),
    history: Array.from({ length: 8 }, (_, i) => ({
      shiur: unclassified(100 + i, { ...shared, teacherId: 50 + i }),
      seconds: 900,
      duration: 900,
    })),
  });
  const sources = recommendationSources(library);
  assert.equal(sources.length, 8);
  assert.deepEqual(
    new Set(sources.map((s) => s.kind)),
    new Set(['teacher', 'series', 'collection', 'topic']),
  );
  assert.ok(sources.some((s) => s.kind === 'collection' && s.id === 40));
  const followed = recommend(
    [unclassified(1, { ...shared, teacherId: 50 })],
    library,
    { followingOnly: true },
  );
  assert.deepEqual(
    followed,
    [],
    'inferred sources never become explicit follows',
  );
});
void test('generic collections and same-name series with different IDs do not imply a relationship', () => {
  const collection = { id: 40, name: 'General Shiurim' };
  const source = unclassified(9, {
    collections: [collection],
    seriesId: 20,
    series: 'Questions',
  });
  const output = recommend(
    [
      unclassified(1, {
        collections: [collection],
        seriesId: 21,
        series: 'Questions',
      }),
    ],
    context({ saved: [source] }),
  );
  assert.equal(output[0].reason, 'From the YUTorah library');
  assert.ok(
    recommendationSources(context({ saved: [source] })).every(
      (s) => s.kind !== 'collection',
    ),
  );
});
void test('indexed recommendations preserve normalized topic matches and the first follow reason', () => {
  const library = context({
    following: [
      { kind: 'topic', id: 10, name: 'SHABBAT!' },
      { kind: 'teacher', id: 50, name: 'Teacher' },
    ],
    history: [
      {
        shiur: shiur(9, { topics: ['TEFILLAH!'] }),
        seconds: 100,
        duration: 900,
      },
      { shiur: shiur(3), seconds: 900, duration: 900 },
      { shiur: shiur(3), seconds: 0, duration: 900 },
    ],
    hidden: [4],
    completed: [5],
  });
  const output = recommend(
    [
      shiur(1, { teacherId: 50 }),
      shiur(2, { topics: ['Tefillah'] }),
      shiur(3),
      shiur(4),
      shiur(5),
    ],
    library,
    { now: Date.parse('2026-09-16') },
  );
  assert.deepEqual(
    output.map((r) => r.shiur.id),
    [1, 2],
  );
  assert.equal(output[0].reason, 'You follow SHABBAT!');
  assert.equal(output[1].reason, 'Because you explore Tefillah');
  const included = recommend([shiur(3), shiur(4), shiur(5)], library, {
    includeCompleted: true,
  });
  assert.deepEqual(included.map((r) => r.shiur.id).sort(), [3, 5]);
});
void test('related learning prioritizes the series and never recommends the current or hidden shiur', () => {
  const source = shiur(1, { seriesId: 20 });
  const output = relatedShiurim(
    source,
    [source, shiur(2, { seriesId: 20 }), shiur(3), shiur(4, { seriesId: 20 })],
    context({ hidden: [4] }),
  );
  assert.equal(output[0].shiur.id, 2);
  assert.ok(output.every((r) => ![1, 4].includes(r.shiur.id)));
});
void test("weekly minutes and streak use calendar days and keep yesterday's streak before today starts", () => {
  const today = new Date(2026, 8, 16, 12);
  const days = { '2026-09-15': 120, '2026-09-14': 180, '2026-09-13': 30 };
  assert.equal(dayKey(today), '2026-09-16');
  const result = learningStats(days, today);
  assert.equal(result.streak, 2);
  assert.equal(result.today, 0);
  assert.equal(result.weekSeconds, 330);
  assert.equal(result.week.length, 7);
  assert.equal(learningStats({ ...days, '2026-09-16': 60 }, today).streak, 3);
});

const { GET } = await load('app/api/feed/route.ts');
void test('feed rejects invalid and excessive source requests before making upstream calls', async () => {
  for (const params of [
    'teacher=-1',
    'teacher=NaN',
    'topic=1.5',
    'series=0',
    'teacher=1,2,3,4,5,6,7,8,9',
  ]) {
    const response = await GET(
      new Request('http://localhost/api/feed?' + params),
    );
    assert.equal(response.status, 400);
  }
});
void test('an empty follow set is a successful empty feed', async () => {
  const response = await GET(new Request('http://localhost/api/feed'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, []);
});
void test('feed fetches bounded sources, deduplicates records and reports partial upstream failure', async () => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (url) => {
    const target = new URL(url);
    paths.push(target);
    if (target.searchParams.get('seriesID'))
      return new Response('Unavailable', { status: 503 });
    return Response.json({
      response: {
        docs: [
          {
            shiurID: 9001,
            shiurTitle: 'Live shiur',
            shiurTeachers: [{ teacherID: 8001, teacherName: 'Teacher' }],
          },
        ],
        numFound: 1,
      },
    });
  };
  try {
    const response = await GET(
      new Request(
        'http://localhost/api/feed?teacher=8001,8001&topic=2001&series=3001',
      ),
    );
    const feed = await response.json();
    assert.equal(feed.sources, 3);
    assert.equal(paths.length, 5);
    const failed = paths.filter((p) => p.searchParams.get('seriesID'));
    assert.equal(failed.length, 3);
    assert.equal(new Set(failed.map((p) => p.href)).size, 1);
    assert.equal(feed.items.length, 1);
    assert.equal(feed.partial, true);
    assert.ok(paths.every((p) => p.searchParams.get('start') === '1'));
    assert.ok(
      paths.some((p) => p.searchParams.get('subcategoryID') === '2001'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('venues and collections match by identity and survive sparse feed merges', () => {
  const venue = { kind: 'venue', id: 439, name: 'Shabbat' },
    collection = { kind: 'collection', id: 15353, name: 'Shabbat' };
  const items = [
    shiur(1, { venueId: 439 }),
    shiur(2, { collections: [{ id: 15353, name: 'Course' }] }),
    shiur(3),
  ];
  assert.equal(followsShiur(items[2], venue), false);
  assert.equal(followsShiur(items[2], collection), false);
  const merged = mergeShiurim([...items, shiur(1), shiur(2)]);
  assert.deepEqual(
    recommend(merged, context({ following: [venue, collection] }), {
      followingOnly: true,
    })
      .map((r) => r.shiur.id)
      .sort(),
    [1, 2],
  );
  assert.equal(
    followsShiur(shiur(4, { topicIds: [99] }), {
      kind: 'topic',
      id: 10,
      name: 'Shabbat',
    }),
    false,
    'Same-name topics do not cross subject identities',
  );
  assert.equal(
    followsShiur(shiur(4, { speakers: [{ id: 9, name: 'Coauthor' }] }), {
      kind: 'teacher',
      id: 9,
      name: 'Coauthor',
    }),
    true,
  );
  assert.equal(
    restoreLearning({ following: [venue, collection, venue] }).following.length,
    2,
  );
});
void test('venue and collection feed requests preserve scoped membership across duplicate records', async () => {
  const originalFetch = globalThis.fetch,
    paths = [];
  globalThis.fetch = async (url) => {
    paths.push(new URL(url));
    return Response.json({
      response: {
        docs: [{ shiurID: 987654, shiurTitle: 'Scoped record' }],
        numFound: 1,
      },
    });
  };
  try {
    const data = await (
      await GET(
        new Request('http://localhost/api/feed?venue=439&collection=15353'),
      )
    ).json();
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].venueId, 439);
    assert.equal(data.items[0].collections[0].id, 15353);
    assert.ok(paths.every((p) => p.searchParams.get('searchTerm') === '*'));
    assert.ok(paths.some((p) => p.searchParams.get('locationID') === '439'));
    assert.ok(
      paths.some((p) => p.searchParams.get('collectionID') === '15353'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
