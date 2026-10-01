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
const { rankTrending, getDiscovery, getRelatedCandidates } =
  await load('lib/discovery.ts');
const { normalize } = await load('lib/yutorah.ts');
const { relatedShiurim, recommend, defaultLearning } =
  await load('lib/learning.ts');
const context = { ...defaultLearning, saved: [], history: [] };
const shiur = (id, values = {}) => ({
  id,
  title: 'Shiur ' + id,
  teacher: 'Teacher',
  teacherId: 10,
  image: '',
  audio: 'https://example.org/audio.mp3',
  url: '',
  duration: 600,
  date: '2026-09-30T00:00:00Z',
  topics: ['Halacha'],
  topicIds: [100],
  category: 'Halacha',
  seriesId: 0,
  series: '',
  description: '',
  language: 'EN',
  format: 'mp3',
  materials: [],
  ...values,
});

void test('popularity uses genuine view counts, deduplicates, and excludes absent or zero counts', () => {
  const result = rankTrending([
    shiur(1),
    shiur(2, { views: 0 }),
    shiur(3, { views: 20 }),
    shiur(4, { views: 40 }),
    shiur(4, { views: undefined, downloads: 2 }),
    shiur(5, { views: 30 }),
  ]);
  assert.deepEqual(
    result.map((s) => s.id),
    [4, 5, 3],
  );
  assert.equal(result[0].views, 40);
});
void test('downloads break genuine view ties and the result respects its bound', () => {
  const result = rankTrending(
    [shiur(1, { views: 20 }), shiur(2, { views: 20, downloads: 5 })],
    1,
  );
  assert.equal(result[0].id, 2);
});
void test('normalization preserves topic IDs from the sparse detail API and explicit view counts', () => {
  const result = normalize({
    shiurID: 1,
    shiurTitle: 'Title',
    shiurSubcategoriesObj: null,
    shiurSubcategories: [100, 200],
    shiurvisitsnum: 0,
    shiurdownloadsnum: 5,
    shiurDate: '2026-09-30T00:00:00',
  });
  assert.deepEqual(result.topicIds, [100, 200]);
  assert.equal(result.views, 0);
  assert.equal(result.downloads, 5);
  assert.equal(result.date, '2026-09-30T00:00:00Z');
  assert.equal(normalize({ shiurID: 2 }).views, undefined);
});
void test('related learning prefers the same short series and explains the match', () => {
  const source = shiur(1, { seriesId: 20, series: 'Ten Minute Halacha' });
  const result = relatedShiurim(
    source,
    [
      source,
      shiur(2, { seriesId: 20, duration: 1800 }),
      shiur(3, { seriesId: 20 }),
      shiur(4, { teacherId: 30 }),
    ],
    context,
  );
  assert.equal(result[0].shiur.id, 3);
  assert.equal(result[0].reason, 'More in Ten Minute Halacha');
  assert.ok(result.every((s) => s.shiur.id !== 1));
});
void test('matching topic IDs connect differently named metadata and beat an unrelated teacher match', () => {
  const source = shiur(1, { topics: [], teacherId: 11, category: '' });
  const result = relatedShiurim(
    source,
    [
      shiur(2, { teacherId: 11, topics: ['Gemara'], topicIds: [200] }),
      shiur(3, { teacherId: 50, topics: ['Kashrut'], topicIds: [100] }),
    ],
    context,
  );
  assert.equal(result[0].shiur.id, 3);
  assert.match(result[0].reason, /Kashrut/);
});
void test('a generic Daily Shiur series does not recommend unrelated learning ahead of the topic', () => {
  const source = shiur(1, { seriesId: 4000, series: 'Daily Shiur' });
  const result = relatedShiurim(
    source,
    [
      shiur(2, {
        seriesId: 4000,
        series: 'Daily Shiur',
        teacherId: 99,
        topics: ['Gemara'],
        topicIds: [200],
        category: 'Gemara',
      }),
      shiur(3, { seriesId: 20, teacherId: 30 }),
    ],
    context,
  );
  assert.deepEqual(
    result.map((s) => s.shiur.id),
    [3],
  );
  assert.match(result[0].reason, /Halacha/);
});
void test('unrelated recommendations never inherit a misleading reason from listening history', () => {
  const source = shiur(1, {
    teacherId: 11,
    topics: ['Tefillah'],
    topicIds: [222],
    category: 'Prayer',
  });
  const unrelated = shiur(2, {
    topics: ['Gemara'],
    topicIds: [333],
    category: 'Gemara',
  });
  assert.deepEqual(
    relatedShiurim(source, [unrelated], { ...context, saved: [unrelated] }),
    [],
  );
});
void test('a fixed ranking time keeps the initial feed deterministic across renders', () => {
  const items = [shiur(1), shiur(2, { date: '2026-09-29T00:00:00Z' })];
  const options = { now: Date.parse('2026-10-01T00:00:00Z') };
  const original = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-01T00:00:00Z');
    const serverResult = recommend(items, context, options);
    Date.now = () => Date.parse('2027-01-01T00:00:00Z');
    assert.deepEqual(recommend(items, context, options), serverResult);
    assert.notEqual(recommend(items, context)[0].score, serverResult[0].score);
    assert.deepEqual(
      serverResult.map((r) => r.shiur.id),
      [1, 2],
    );
  } finally {
    Date.now = original;
  }
});
void test('discovery keeps the sample for duration filters and discloses a failed page', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const params = new URL(url).searchParams;
    requests.push(params);
    const page = Number(params.get('start'));
    if (page === 3) return new Response('Unavailable', { status: 503 });
    return Response.json({
      response: {
        docs: Array.from({ length: 3 }, (_, i) => ({
          shiurid: 30000 + page * 10 + i,
          shiurtitle: 'Recording',
          shiurvisitsnum: page * 10 - i,
          duration: page === 1 ? 5 : 60,
        })),
      },
    });
  };
  try {
    const result = await getDiscovery();
    assert.equal(requests.length, 6);
    assert.deepEqual(
      requests.map((p) => p.get('start')).sort((a, b) => Number(a) - Number(b)),
      ['1', '2', '3', '4', '5', '6'],
    );
    assert.equal(result.sampled, 15);
    assert.equal(result.partial, true);
    assert.deepEqual(
      result.trending.map((s) => s.views),
      [60, 59, 58, 50, 49, 48, 40, 39, 38, 20, 19, 18, 10, 9, 8],
    );
    assert.deepEqual(
      result.trending.filter((s) => s.duration <= 600).map((s) => s.id),
      [30010, 30011, 30012],
    );
  } finally {
    globalThis.fetch = original;
  }
});
void test('related candidates fetch the series, two topics, and teacher even with sparse detail metadata', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const target = new URL(url);
    if (target.pathname.endsWith('/shiur/details'))
      return Response.json({
        shiurID: 40001,
        shiurTitle: 'Ten Minute Halacha',
        shiurSeries: 40002,
        shiurSubcategories: [40003, 40004],
        shiurTeachers: [{ teacherID: 40005, teacherName: 'Teacher' }],
      });
    requests.push(target.searchParams);
    return Response.json({
      response: {
        docs: [
          { shiurid: 40001, shiurtitle: 'Current' },
          { shiurid: 40006, shiurtitle: 'Next', mediatypename: 'MP3' },
        ],
      },
    });
  };
  try {
    const result = await getRelatedCandidates(40001);
    assert.equal(requests.length, 4);
    for (const [field, id] of [
      ['seriesID', '40002'],
      ['subcategoryID', '40003'],
      ['subcategoryID', '40004'],
      ['teacherID', '40005'],
    ])
      assert.ok(requests.some((p) => p.get(field) === id));
    assert.deepEqual(
      result.items.map((s) => s.id),
      [40006],
    );
    assert.equal(result.partial, false);
  } finally {
    globalThis.fetch = original;
  }
});
const { GET } = await load('app/api/related/route.ts');
void test('related endpoint rejects missing, malformed and zero IDs before contacting YUTorah', async () => {
  for (const id of ['', '0', '-1', '1.5', 'x']) {
    const response = await GET(
      new Request('http://localhost/api/related?id=' + id),
    );
    assert.equal(response.status, 400);
  }
});
