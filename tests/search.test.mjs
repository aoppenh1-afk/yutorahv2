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
  suggestSearch,
  searchText,
  highlightParts,
  relevanceScore,
  matchExcerpt,
} = await load('lib/search-discovery.ts');
const { parseSearch } = await load('lib/yutorah.ts');
const directory = {
  teachers: [
    {
      id: 1,
      name: 'Rabbi Hershel Schachter',
      firstName: 'Hershel',
      lastName: 'Schachter',
      count: 7500,
    },
    {
      id: 2,
      name: 'Rabbi Shay Schachter',
      firstName: 'Shay',
      lastName: 'Schachter',
      count: 2000,
    },
    {
      id: 3,
      name: 'Rabbi Zvi Sobolofsky',
      firstName: 'Zvi',
      lastName: 'Sobolofsky',
      count: 4000,
    },
  ],
  topics: [{ id: 10, name: 'Shabbat', count: 5000, group: 'Halacha' }],
  series: [{ id: 20, name: 'Daf Yomi', count: 48000, description: '' }],
  groups: ['Halacha'],
};

void test('name suggestions tolerate missing letters while preserving exact matches first', () => {
  assert.equal(suggestSearch('Hershel Schacter', directory)[0].id, 1);
  assert.equal(suggestSearch('Rav Hershel Schachter', directory)[0].id, 1);
  assert.equal(suggestSearch('Shay Schachter', directory)[0].id, 2);
  assert.equal(
    suggestSearch('unrelated astronomical query', directory).length,
    0,
  );
});

void test('teacher, topic and series suggestions preserve their entity types', () => {
  assert.equal(suggestSearch('Shabbat', directory)[0].kind, 'topic');
  assert.equal(suggestSearch('Daf Yomi', directory)[0].kind, 'series');
  assert.equal(
    suggestSearch('Schachter', directory).filter((s) => s.kind === 'teacher')
      .length,
    2,
  );
});

void test('ambiguous surnames never silently select a teacher', () => {
  assert.equal(
    parseSearch('teshuva by Rav Schachter', {}, directory).teacherId,
    0,
  );
  assert.equal(
    parseSearch('teshuva by Rav Sobolofsky', {}, directory).teacherId,
    3,
  );
  const plan = parseSearch(
    'teshuva by Rav Hershel   Schachter under 30 minutes',
    {},
    directory,
  );
  assert.equal(plan.teacherId, 1);
  assert.equal(plan.term, 'teshuva');
  assert.equal(plan.max, 30);
  assert.equal(
    parseSearch('teshuva by Rav Hershel Schachter', { teacherId: 1 }, directory)
      .term,
    'teshuva',
  );
});

void test('ordinary duration, media, and Hebrew topic phrasing produces disclosed filters', () => {
  const plan = parseSearch('20-minute shiur on Shabbat', {}, directory);
  assert.equal(plan.max, 20);
  assert.equal(plan.term, 'Shabbat');
  assert.equal(
    parseSearch('audio shiurim on teshuva', {}, directory).format,
    'audio',
  );
  const hebrew = parseSearch('תשובה', {}, directory);
  assert.equal(hebrew.term, 'teshuva');
  assert.ok(hebrew.labels.includes('תשובה → teshuva'));
});

void test('text normalization and highlighting preserve safe visible text', () => {
  assert.equal(searchText('תְּפִלָּה'), searchText('תפלה'));
  assert.equal(searchText('  Hershel   Schachter  '), 'hershel schachter');
  const original = 'A <script> teshuva & tefillah';
  const parts = highlightParts(original, 'teshuva [script]');
  assert.equal(parts.map((p) => p.text).join(''), original);
  assert.deepEqual(
    parts.filter((p) => p.match).map((p) => p.text),
    ['teshuva'],
  );
});

void test('direct title matches rank ahead of incidental description matches', () => {
  const base = { topics: [], series: '', teacher: '', description: '' };
  assert.ok(
    relevanceScore({ ...base, title: 'Rambam Hilchos Teshuva' }, 'teshuva') >
      relevanceScore(
        {
          ...base,
          title: 'A general lecture',
          description: 'Also touches on teshuva',
        },
        'teshuva',
      ),
  );
  const excerpt = matchExcerpt(
    'Opening context. '.repeat(30) +
      'The teshuva discussion starts here. ' +
      'Closing remarks. '.repeat(20),
    'teshuva',
  );
  assert.ok(excerpt.includes('teshuva'));
  assert.ok(excerpt.length <= 232);
});

void test('quoted phrases and excluded words become persistent filters', () => {
  const plan = parseSearch('"hilchos teshuva" -parsha -introduction');
  assert.equal(plan.phrase, 'hilchos teshuva');
  assert.equal(plan.exclude, 'parsha introduction');
  assert.equal(plan.term, 'hilchos teshuva');
  assert.ok(plan.labels.includes('Exact phrase: hilchos teshuva'));
});

const { matchesPlan } = await load('lib/yutorah.ts');
const shiur = {
  title: 'Rambam Hilchos Teshuva',
  teacher: 'Rabbi Example',
  series: '',
  topics: [],
  description: 'A discussion about repentance.',
  duration: 1800,
  date: '2026-09-08T18:00:00Z',
  materials: [{ name: 'Sources', url: 'https://example.org/sources.pdf' }],
  language: 'EN',
  format: 'mp3',
  audio: '',
};

void test('advanced filters combine and date endpoints include the whole day', () => {
  const plan = parseSearch('', {
    min: 20,
    max: 30,
    after: '2026-09-08',
    before: '2026-09-08',
    phrase: 'hilchos teshuva',
    exclude: 'parsha',
  });
  assert.equal(matchesPlan(shiur, plan), true);
  for (const patch of [
    { duration: 1000 },
    { duration: 1900 },
    { date: '2026-09-09T00:00:00Z' },
    { date: '' },
    { title: 'Parsha: Hilchos Teshuva' },
  ]) {
    assert.equal(
      matchesPlan({ ...shiur, ...patch }, plan),
      false,
      JSON.stringify(patch),
    );
  }
});

void test('phrase and exclusion filters use normalized whole words', () => {
  assert.equal(
    matchesPlan(shiur, parseSearch('', { phrase: 'HILCHOS, TESHUVA' })),
    true,
  );
  assert.equal(
    matchesPlan(shiur, parseSearch('', { phrase: 'hilchos teshuvah' })),
    false,
  );
  assert.equal(matchesPlan(shiur, parseSearch('', { exclude: 'ram' })), true);
  assert.equal(
    matchesPlan(shiur, parseSearch('', { exclude: 'Rambam' })),
    false,
  );
});

void test('title scope excludes incidental description matches', () => {
  assert.equal(
    matchesPlan(shiur, parseSearch('discussion', { scope: 'title' })),
    false,
  );
  assert.equal(
    matchesPlan(shiur, parseSearch('rambam teshuva', { scope: 'title' })),
    true,
  );
  assert.equal(
    matchesPlan(
      shiur,
      parseSearch('', { phrase: 'discussion about', scope: 'title' }),
    ),
    false,
  );
  assert.equal(
    matchesPlan(shiur, parseSearch('', { phrase: 'discussion about' })),
    true,
  );
});

void test('natural searching understands time budgets, ranges and ordering', () => {
  let plan = parseSearch(
    'Show me the newest shiurim on teshuva under thirty minutes',
  );
  assert.equal(plan.term, 'teshuva');
  assert.equal(plan.max, 30);
  assert.equal(plan.sort, 'new');
  assert.equal(
    parseSearch('Find a shiur on teshuva under twenty-five minutes').max,
    25,
  );
  plan = parseSearch(
    'I have half an hour to listen. Find me a shiur about Shabbat',
  );
  assert.equal(plan.max, 30);
  assert.equal(plan.term.replace(/[.]/g, '').trim(), 'Shabbat');
  plan = parseSearch(
    'Find me English shiurim on tefillah between 10 and 25 minutes, shortest first',
  );
  assert.equal(plan.language, 'EN');
  assert.equal(plan.min, 10);
  assert.equal(plan.max, 25);
  assert.equal(plan.sort, 'short');
});

void test('natural questions keep their specific subject instead of collapsing to a broad topic', () => {
  const plan = parseSearch('How do I pray on Shabbat?');
  assert.match(plan.term, /tefillah/);
  assert.match(plan.term, /Shabbat/);
  assert.equal(parseSearch('How can I improve my prayer?').term, 'tefillah');
  assert.equal(parseSearch('"what is prayer"').phrase, 'what is prayer');
});

void test('relative dates are deterministic and explicit filters win', async () => {
  const { naturalSearch } = await load('lib/natural-search.ts');
  const parsed = naturalSearch(
    'Find me shiurim on teshuva from last year',
    new Date('2026-09-08T12:00:00Z'),
  );
  assert.equal(parsed.options.after, '2025-01-01');
  assert.equal(parsed.options.before, '2025-12-31');
  assert.equal(parseSearch('short shiurim on teshuva', { max: 45 }).max, 45);
  assert.equal(
    parseSearch('newest shiurim on teshuva', { sort: 'short' }).sort,
    'short',
  );
});
