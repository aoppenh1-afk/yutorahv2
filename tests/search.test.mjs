import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

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
const { matchQuery: directoryMatch } = await load('lib/search-matching.ts');

void test('an empty directory filter stays responsive across thousands of entries', () => {
  const start = performance.now();
  for (let i = 0; i < 4000; i++)
    assert.equal(directoryMatch(`Rabbi Teacher ${i}`, ''), true);
  assert.ok(
    performance.now() - start < 150,
    'Empty filters must not perform spelling analysis for each entry',
  );
});
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

void test('submitted teacher names support typos and incomplete words without guessing ambiguous surnames', () => {
  const plan = parseSearch(
    'teshvu by Rabbi Hershl Schact under 30 minutes',
    {},
    directory,
  );
  assert.equal(plan.teacherId, 1);
  assert.equal(plan.max, 30);
  assert.ok(
    plan.labels.some((label) =>
      label.includes('Hershl Schact → Rabbi Hershel Schachter'),
    ),
  );
  assert.equal(parseSearch('Rabbi Sobolofsk', {}, directory).teacherId, 3);
  assert.equal(parseSearch('her schach', {}, directory).teacherId, 1);
  const ambiguous = parseSearch('teshuva by Rabbi Schact', {}, directory);
  assert.equal(ambiguous.teacherId, 0);
  assert.equal(ambiguous.term, 'teshuva Schact');
  assert.equal(
    parseSearch('teshuva by Rabbi Hershl Schact', { teacherId: 2 }, directory)
      .teacherId,
    2,
  );
});

void test('suggestions combine typos with partial words and transliteration aliases', () => {
  assert.equal(suggestSearch('Hershl Schact', directory)[0].id, 1);
  assert.equal(suggestSearch('Hreshel Schachter', directory)[0].id, 1);
  assert.equal(suggestSearch('shabos', directory)[0].id, 10);
  assert.equal(suggestSearch('שבת', directory)[0].id, 10);
  const series = parseSearch('Daf Yom', {}, directory);
  assert.equal(series.seriesId, 20);
  assert.equal(series.term, '');
});

void test('misspelled conversational subjects and filter words become useful, disclosed queries', () => {
  const plan = parseSearch(
    'Plase show me shuirim about pryaer on Shabos undr thirty minuts',
    {},
    directory,
  );
  assert.equal(plan.term, 'tefillah on Shabbat');
  assert.equal(plan.max, 30);
  assert.ok(plan.labels.some((label) => label.includes('pryaer → tefillah')));
  assert.ok(plan.labels.some((label) => label.includes('undr → under')));
  assert.equal(parseSearch('How can I imprve my pryaer?').term, 'tefillah');
  assert.equal(parseSearch('"pryaer on Shabos"').term, 'pryaer on Shabos');
  assert.equal(parseSearch('"pryaer on Shabos"').phrase, 'pryaer on Shabos');
});

void test('fuzzy title matching, highlighting and excerpts use the same normalized words', () => {
  assert.equal(
    matchesPlan(shiur, parseSearch('rambm tesh', { scope: 'title' })),
    true,
  );
  assert.equal(
    matchesPlan(shiur, parseSearch('astronomy', { scope: 'title' })),
    false,
  );
  const text = 'תְּפִלָּה — Hershel Schachter: Teshuva';
  const parts = highlightParts(text, 'תפלה Hershl Schact tesh');
  assert.equal(parts.map((part) => part.text).join(''), text);
  assert.deepEqual(
    parts.filter((part) => part.match).map((part) => part.text),
    ['תְּפִלָּה', 'Hershel', 'Schachter', 'Teshuva'],
  );
  const excerpt = matchExcerpt(
    'Opening. '.repeat(50) +
      'The Schachter lecture starts here. ' +
      'Ending. '.repeat(50),
    'Schact',
  );
  assert.ok(excerpt.includes('Schachter'));
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Teshuva' },
      parseSearch('"teshuvah"', { scope: 'title' }),
    ),
    false,
  );
});

void test('relevance rewards literal title matches over fuzzy and incidental matches', () => {
  const base = { topics: [], series: '', teacher: '', description: '' };
  const exact = relevanceScore({ ...base, title: 'Prayer' }, 'prayer');
  const fuzzy = relevanceScore({ ...base, title: 'Prayers' }, 'prayer');
  const incidental = relevanceScore(
    { ...base, title: 'Other lecture', description: 'Prayer' },
    'prayer',
  );
  assert.ok(exact > fuzzy);
  assert.ok(fuzzy > incidental);
  assert.ok(
    relevanceScore({ ...base, title: 'Rabbi Schachter' }, 'Schact') >
      relevanceScore(
        { ...base, title: 'Other lecture', description: 'Schachter' },
        'Schact',
      ),
  );
});

const {
  librarySearchQuery,
  searchVocabulary,
  wordMatch,
  typoBudget,
  interpretSpacing,
  matchQuery,
} = await load('lib/search-matching.ts');

void test('ranking favors complete intent and nearby subjects over partial or scattered mentions', () => {
  const base = { topics: [], series: '', teacher: '', description: '' };
  const query = 'tefillah shabbat';
  const near = { ...base, title: 'Tefillah Shabbos: Laws' };
  const far = {
    ...base,
    title: 'Tefillah: laws, insights and practice for Shabbos',
  };
  assert.ok(relevanceScore(near, query) > relevanceScore(far, query));
  assert.ok(
    relevanceScore(near, query) >
      relevanceScore(
        {
          ...base,
          title: 'Tefillah',
          topics: ['Prayer'],
          series: 'Tefillah',
          teacher: 'Tefillah',
          description: 'Tefillah',
        },
        query,
      ),
  );
  assert.ok(
    relevanceScore({ ...base, title: 'Organ Donation' }, 'organ doan') >
      relevanceScore(
        { ...base, title: 'Loan Interest', description: 'organ' },
        'organ doan',
      ),
  );
  assert.ok(
    relevanceScore({ ...base, title: 'Hilchos Shabbat' }, 'hilchos shabbat') >
      relevanceScore(
        { ...base, title: 'Hilchos Shabbaton' },
        'hilchos shabbat',
      ),
  );
});

void test('ordinary question wording is removed while the specific subjects and constraints survive', () => {
  for (const query of [
    'What should I know about prayer on Shabbat?',
    'Can you explain the laws of prayer on Shabbat?',
    'I would like to learn more about prayer on Shabbat',
    'Tell me about prayer on Shabbat',
    'Explain prayer on Shabbat to me',
    'Could you help me understand prayer on Shabbat',
    'I need information about prayer on Shabbat',
    'How does prayer on Shabbat work?',
    'What are the rules for prayer on Shabbat?',
    'Where can I learn about prayer on Shabbat?',
  ]) {
    const plan = parseSearch(query, { scope: 'title' });
    assert.equal(
      matchesPlan({ ...shiur, title: 'Tefillah on Shabbos' }, plan),
      true,
      `${query}: ${plan.term}`,
    );
    assert.equal(
      matchesPlan({ ...shiur, title: 'Tefillah on Pesach' }, plan),
      false,
    );
  }
  const quote = parseSearch('"what should I know"');
  assert.equal(quote.phrase, 'what should I know');
  assert.match(
    parseSearch('Can I work on Shabbat?').term,
    /work/,
    'The action in a question stays a subject',
  );
});

void test('missing and extra spaces recover live directory entities without changing exact phrases', () => {
  const names = {
    ...directory,
    topics: [
      ...directory.topics,
      { id: 40, name: 'Rosh Hashana', count: 1000, group: 'Holidays' },
    ],
  };
  assert.equal(parseSearch('dafyomi', {}, names).seriesId, 20);
  const holiday = parseSearch('roshhashana', { scope: 'title' }, names);
  assert.equal(matchesPlan({ ...shiur, title: 'Rosh Hashana' }, holiday), true);
  const teacher = parseSearch('HershelSchachter', {}, names);
  assert.equal(teacher.teacherId, 1);
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Tefillah' },
      parseSearch('te fillah', { scope: 'title' }, names),
    ),
    true,
  );
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Daf Yomi' },
      parseSearch('"dafyomi"', { scope: 'title' }, names),
    ),
    false,
  );
  assert.ok(holiday.labels.some((label) => label.includes('roshhashana →')));
  assert.equal(suggestSearch('HershelSchachter', names)[0]?.id, 1);
  assert.equal(suggestSearch('dafyomi', names)[0]?.id, 20);
  assert.equal(
    interpretSpacing('abc def', ['abc def', 'abcdef']).term,
    'abc def',
    'Ambiguous readings remain literal',
  );
  assert.equal(interpretSpacing('mycustomtopic').term, 'mycustomtopic');
  assert.equal(matchQuery('Rabbi Hershel Schachter', 'HershelSchachter'), true);
  assert.equal(matchQuery('Organ Donation', 'OrganDonation'), true);
  assert.equal(matchQuery('Notebook', 'note book'), true);
  assert.deepEqual(
    highlightParts('Tefillah', 'te fillah')
      .filter((part) => part.match)
      .map((part) => part.text),
    ['Tefillah'],
  );
});

const { searchRetrieval } = await load('lib/search-matching.ts');
void test('related retrieval keeps known subjects and numeric constraints and never becomes a broad OR search', () => {
  const recovery = searchRetrieval('tefillah shabbat practical');
  assert.ok(recovery.relatedQuery);
  assert.equal(recovery.matches('Tefillah on Shabbos', true), true);
  assert.equal(recovery.matches('Practical Tefillah', true), false);
  assert.equal(recovery.matches('Practical Shabbos', true), false);
  assert.equal(recovery.matches('Tefillah on Shabbos'), false);
  const numbers = searchRetrieval('rambam 613 practical');
  assert.equal(numbers.matches('Rambam 613', true), true);
  assert.equal(numbers.matches('Rambam practical 614', true), false);
  assert.equal(searchRetrieval('tefillah shabbat').relatedQuery, '');
  assert.equal(searchRetrieval('shabbat pesach tefillah').relatedQuery, '');
  assert.equal(searchRetrieval('word '.repeat(33)).relatedQuery, '');
  assert.ok(recovery.relatedQuery.length < 4000);
  assert.ok(
    searchRetrieval('tefillah shabbat practical', ['practical']).relatedQuery,
    'Generic modifiers may relax even when present in series names',
  );
});

void test('short missing letters and transposed partial words find the intended title and series', () => {
  const daf = { ...shiur, title: 'Daf Yomi' };
  for (const query of ['daf ymi', 'daf ymo']) {
    assert.equal(
      matchesPlan(daf, parseSearch(query, { scope: 'title' })),
      true,
      query,
    );
    assert.equal(suggestSearch(query, directory)[0]?.id, 20, query);
    assert.equal(parseSearch(query, {}, directory).seriesId, 20, query);
  }
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Organ Donation' },
      parseSearch('doan', { scope: 'title' }),
    ),
    true,
  );
  assert.equal(
    wordMatch('daf', 'dav'),
    0,
    'Short unrelated words stay distinct',
  );
  assert.equal(wordMatch('on', 'in'), 0);
  assert.equal(wordMatch('2026', '2025'), 0);
  assert.equal(
    matchesPlan(daf, parseSearch('"daf ymi"', { scope: 'title' })),
    false,
  );
});

void test('connecting words do not hide results while every requested subject remains required', () => {
  const title = { ...shiur, title: 'Hilchos Shabbat' };
  for (const query of [
    'hilchos on shabbat',
    'the hilchos of shabbat',
    'hilchos and shabbat',
  ])
    assert.equal(
      matchesPlan(title, parseSearch(query, { scope: 'title' })),
      true,
      query,
    );
  assert.equal(
    matchesPlan(title, parseSearch('hilchos on pesach', { scope: 'title' })),
    false,
  );
  assert.equal(
    matchesPlan(title, parseSearch('"hilchos on shabbat"', { scope: 'title' })),
    false,
  );
  assert.deepEqual(
    highlightParts(title.title, 'the hilchos of shabbat')
      .filter((part) => part.match)
      .map((part) => part.text),
    ['Hilchos', 'Shabbat'],
  );
  const base = { topics: [], series: '', teacher: '', description: '' };
  assert.ok(
    relevanceScore(
      { ...base, title: 'Hilchos Shabbat' },
      'hilchos on shabbat',
    ) >
      relevanceScore(
        { ...base, title: 'A lecture on Shabbat' },
        'hilchos on shabbat',
      ),
  );
});

void test('archive retrieval expands short typos and ignores connecting words without dropping subjects', () => {
  const vocabulary = searchVocabulary(['Daf Yomi']);
  for (const query of ['ymi', 'ymo'])
    assert.match(librarySearchQuery(query, vocabulary), /\byomi\b/, query);
  assert.match(librarySearchQuery('doan'), /dona\*/);
  assert.doesNotMatch(librarySearchQuery('doan'), /do\?n\*/);
  assert.equal(
    librarySearchQuery('hilchos on shabbat'),
    librarySearchQuery('hilchos shabbat'),
  );
  assert.equal(
    librarySearchQuery('the hilchos of shabbat'),
    librarySearchQuery('hilchos shabbat'),
  );
  assert.match(librarySearchQuery('hilchos on pesach'), / AND /);
  assert.equal(
    librarySearchQuery('on'),
    'on',
    'A query containing only connecting words stays literal',
  );
});

const { transcriptSearchClauses, searchVariants } = await load(
  'packages/yutorah-core/src/search.ts',
);

void test('intent search connects everyday questions to relevant Torah concepts', () => {
  const examples = [
    ['How can I control my temper?', 'Overcoming Kaas'],
    ["I'm struggling with anxiety", 'Building Bitachon'],
    ['How do I cope with losing a loved one?', 'Hilchos Aveilus'],
    ['How can I stop gossiping?', 'The Laws of Lashon Hara'],
    ['What does Judaism say about respecting my parents?', 'Kibbud Av Vaem'],
    ['How can I be more grateful?', 'Hakaras Hatov'],
    ['How can I have more peace at home?', 'Shalom Bayis'],
    ['How can I control my tempre?', 'Overcoming Kaas'],
    ['anxeity', 'Building Bitachon'],
    ['How can I be a better person?', 'Mussar and Middos'],
    ['Can I cook on Shabbat?', 'Bishul on Shabbos'],
  ];
  for (const [query, title] of examples) {
    const plan = parseSearch(query, { scope: 'title' });
    assert.equal(
      matchesPlan({ ...shiur, title }, plan),
      true,
      `${query}: ${plan.term}`,
    );
    assert.ok(
      plan.labels.some((label) => label.startsWith('Related topics:')),
      query,
    );
    assert.equal(
      matchesPlan({ ...shiur, title: 'Hilchos Eruvin' }, plan),
      false,
      query,
    );
  }
});

void test('intent search keeps specific subjects, teachers, time budgets and literal overrides', () => {
  const plan = parseSearch(
    'Find me English shiurim about dealing with anxiety on Shabbat by Rabbi Hershl Schact under twenty minutes',
    {},
    directory,
  );
  assert.equal(plan.teacherId, 1);
  assert.equal(plan.max, 20);
  assert.equal(plan.language, 'EN');
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Bitachon on Shabbos', duration: 900 },
      { ...plan, scope: 'title' },
    ),
    true,
  );
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Bitachon on Pesach', duration: 900 },
      { ...plan, scope: 'title' },
    ),
    false,
  );
  const literal = parseSearch('"control my temper"');
  assert.equal(literal.term, 'control my temper');
  assert.equal(literal.phrase, 'control my temper');
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Overcoming Kaas', description: '' },
      literal,
    ),
    false,
  );
  assert.doesNotMatch(
    librarySearchQuery(plan.term),
    /dealing|\banxiety~|\bon\b/,
  );
  assert.match(librarySearchQuery(plan.term), /bitachon/);
  assert.match(librarySearchQuery(plan.term), / AND /);
});

void test('intent retrieval, suggestions, ranking and highlights share related concepts', () => {
  const semanticDirectory = {
    ...directory,
    topics: [
      ...directory.topics,
      { id: 30, name: 'Bitachon', count: 300, group: 'Hashkafa' },
      { id: 31, name: 'Lashon Hara', count: 400, group: 'Halacha' },
    ],
  };
  assert.equal(
    suggestSearch("I'm struggling with anxiety", semanticDirectory)[0]?.id,
    30,
  );
  assert.equal(
    suggestSearch('How can I stop gossiping?', semanticDirectory)[0]?.id,
    31,
  );
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Kol Lashon and Har Gerizim', description: '' },
      parseSearch('gossip', { scope: 'title' }),
    ),
    false,
  );
  assert.match(librarySearchQuery('gossip'), /lashon/);
  assert.match(librarySearchQuery('gossip'), /hara/);
  assert.doesNotMatch(
    librarySearchQuery('daf', searchVocabulary(['Daf Yomi'])),
    /daven/,
  );
  assert.doesNotMatch(transcriptSearchClauses('daf').all, /daven|prayer/);
  assert.match(
    transcriptSearchClauses('gossip').all,
    /'lashon':\*.* & .*'hara':\*/,
  );
  assert.deepEqual(
    highlightParts('The Laws of Lashon Hara', 'gossip')
      .filter((part) => part.match)
      .map((part) => part.text),
    ['Lashon', 'Hara'],
  );
  const base = { topics: [], series: '', teacher: '', description: '' };
  assert.ok(
    relevanceScore({ ...base, title: 'Dealing with Anxiety' }, 'anxiety') >
      relevanceScore({ ...base, title: 'Building Bitachon' }, 'anxiety'),
  );
  assert.ok(
    relevanceScore({ ...base, title: 'Building Bitachon' }, 'anxiety') >
      relevanceScore({ ...base, title: 'Other Lecture' }, 'anxiety'),
  );
});

void test('smart transcript clauses accept short spelling candidates and optional connecting words', () => {
  const candidates = new Map([
    ['ymi', ['yomi', 'ami']],
    ['ymo', ['yomi']],
  ]);
  for (const query of ['daf ymi', 'daf ymo']) {
    const clauses = transcriptSearchClauses(query, candidates);
    assert.match(clauses.all, /'yomi':\*/);
    assert.equal(clauses.spellingExpanded, true);
    assert.doesNotMatch(clauses.all, /'ami'/);
  }
  assert.equal(
    transcriptSearchClauses('hilchos on shabbat').all,
    transcriptSearchClauses('hilchos shabbat').all,
  );
  assert.deepEqual(searchVariants('hilchos on shabbat', false), [
    'hilchos on shabbat',
  ]);
});

void test('retrieval compiles bounded typo/prefix clauses, keeps all subjects, and never forwards query syntax', () => {
  const query = librarySearchQuery(
    'Schact rambm',
    searchVocabulary(['Hershel Schachter', 'Rambam']),
  );
  assert.match(query, /schact\*/);
  assert.match(query, /schact~1/);
  assert.match(query, /schachter/);
  assert.match(query, / AND /);
  assert.match(query, /rambm~1/);
  assert.match(librarySearchQuery('donait'), /donati\*/);
  assert.match(librarySearchQuery('donait'), /dona\?it\*/);
  assert.match(librarySearchQuery('tefillah Shabbat'), /prayer/);
  assert.match(librarySearchQuery('tefillah Shabbat'), /שבת/);
  assert.doesNotMatch(librarySearchQuery('eruv'), /eruv~/);
  assert.equal(librarySearchQuery('2026'), '2026');
  assert.equal(typoBudget('daf'), 0);
  assert.equal(wordMatch('2026', '2025'), 0);
  assert.equal(wordMatch('daf', 'dav'), 0);
  assert.equal(wordMatch('Schact'.toLowerCase(), 'schachter'), 0.5);
  assert.ok(wordMatch('hreshel', 'hershel') > 0);
  const injection = librarySearchQuery('title:* OR (*:*)^999 { !lucene }');
  assert.doesNotMatch(injection, /[:{}!^]/);
  assert.equal(librarySearchQuery(''), '');
  assert.throws(() => librarySearchQuery('???'), RangeError);
  assert.throws(
    () =>
      librarySearchQuery(
        Array.from({ length: 33 }, (_, i) => `word${i}`).join(' '),
      ),
    RangeError,
  );
  const long = librarySearchQuery(
    Array.from(
      { length: 30 },
      (_, i) =>
        'lecture' + String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26)),
    ).join(' '),
  );
  assert.ok(long.length < 4000);
});

void test('a broader intent corpus recognizes rituals, ethics, life events, and Hebrew questions', () => {
  const corpus = JSON.parse(
    readFileSync(
      new URL('./fixtures/search-intents.json', import.meta.url),
      'utf8',
    ),
  );
  const failures = [];
  for (const { query, title, required } of corpus) {
    const plan = parseSearch(query, { scope: 'title' });
    if (!matchesPlan({ ...shiur, title }, plan))
      failures.push(`${query} → ${plan.term} misses ${title}`);
    assert.equal(
      matchesPlan({ ...shiur, title: 'Astronomy and Eruvin' }, plan),
      false,
      query,
    );
    if (required)
      assert.ok(
        matchQuery(plan.term, required),
        `${query} must retain ${required}`,
      );
  }
  assert.deepEqual(failures, []);
});

void test('word families and Hebrew prefixes are recognized without treating unfamiliar words as known subjects', () => {
  assert.ok(wordMatch('studies', 'studying') >= 0.9);
  assert.ok(wordMatch('children', 'child') >= 0.9);
  assert.ok(wordMatch('ולשבת', 'שבת') >= 0.9);
  assert.ok(wordMatch('honoured', 'honouring') >= 0.9);
  assert.equal(wordMatch('2026', '2025'), 0);
  assert.equal(wordMatch('gas', 'ga'), 0);
  assert.ok(
    wordMatch('news', 'new') < 0.9,
    'An unfamiliar suffix gets only ordinary spelling tolerance',
  );
  assert.ok(
    wordMatch('ובהמצאהחדשה', 'המצאהחדשה') < 0.9,
    'Unknown Hebrew words are not prefix-normalized',
  );
  assert.ok(librarySearchQuery('studies').includes('study'));
  assert.ok(librarySearchQuery('ובשבת').includes('shabbos'));
});

void test('recognition preserves exact quotes, unknown qualifiers, and distinct adjacent concepts', () => {
  const plan = parseSearch('hospitality and loan interest on Shabbat', {
    scope: 'title',
  });
  assert.equal(
    matchesPlan({ ...shiur, title: 'Hachnasas Orchim Ribbis Shabbos' }, plan),
    true,
  );
  assert.equal(
    matchesPlan({ ...shiur, title: 'Hachnasas Orchim Shabbos' }, plan),
    false,
  );
  assert.equal(
    matchesPlan({ ...shiur, title: 'Ribbis on Pesach' }, plan),
    false,
  );
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Birkat Hamazon' },
      parseSearch('"grace after meals"'),
    ),
    false,
  );
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Pikuach Nefesh' },
      parseSearch('"saving a life"'),
    ),
    false,
  );
  assert.ok(parseSearch('hospitality astronomy').term.includes('astronomy'));
  assert.equal(
    searchRetrieval('not hospitality shabbat').relatedQuery,
    '',
    'Recovery cannot discard negation',
  );
  assert.doesNotMatch(librarySearchQuery('get'), /gittin|גט/);
  assert.doesNotMatch(librarySearchQuery('interest'), /ribbis|ריבית/);
});

void test('teacher initials select a teacher only with a unique full surname', () => {
  for (const query of ['Rabbi H. Schachter', 'Rav H Schachter', 'H. Schachter'])
    assert.equal(parseSearch(query, {}, directory).teacherId, 1, query);
  const ambiguous = {
    ...directory,
    teachers: [
      ...directory.teachers,
      {
        id: 4,
        firstName: 'Hillel',
        lastName: 'Schachter',
        name: 'Rabbi Hillel Schachter',
        count: 100,
      },
    ],
  };
  assert.equal(parseSearch('Rabbi H Schachter', {}, ambiguous).teacherId, 0);
  assert.equal(
    parseSearch('Rabbi H Schach', {}, directory).teacherId,
    0,
    'An initial with an incomplete surname is insufficient',
  );
  assert.equal(suggestSearch('Rabbi H. Schachter', directory)[0]?.id, 1);
  assert.deepEqual(
    suggestSearch('H Schachter', ambiguous)
      .map((entry) => entry.id)
      .sort(),
    [1, 4],
  );
});

void test('recognized neighboring words do not become each other through typo correction', () => {
  assert.equal(parseSearch('morning').term, 'morning');
  assert.equal(wordMatch('morning', 'mourning'), 0);
  assert.equal(wordMatch('eruv', 'erev'), 0);
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Mourning Prayer' },
      parseSearch('morning prayer', { scope: 'title' }),
    ),
    false,
  );
  assert.doesNotMatch(librarySearchQuery('morning prayer'), /morning~/);
  assert.ok(matchQuery('Children and Child', "children's"));
});

void test('smart transcript search preserves words when request cleanup removes the entire query', () => {
  for (const [query, word] of [
    ['what about', 'what'],
    ['how', 'how'],
    ['can', 'can'],
  ]) {
    const clauses = transcriptSearchClauses(query);
    assert.ok(clauses.all.includes(`'${word}':*`), query);
    assert.ok(clauses.any.includes(`'${word}':*`), query);
  }
});

void test('questions share subject recognition across metadata, local search, and smart transcript retrieval', () => {
  assert.equal(
    matchQuery('Hachnasas Orchim', 'How can I welcome guests?'),
    true,
  );
  assert.equal(
    matchQuery('Shacharis', 'Can I learn about morning prayers?'),
    true,
  );
  const question = transcriptSearchClauses('How can I welcome guests?');
  assert.match(question.all, /hachnasas/);
  assert.doesNotMatch(question.all, /'how'|'can'|'i'/);
  assert.match(
    transcriptSearchClauses('counting the omer').all,
    /sefirat|sefiras/,
  );
  assert.match(transcriptSearchClauses('מברכים אחרי האוכל').all, /hamazon/);
  assert.doesNotMatch(
    transcriptSearchClauses('welcoming guests', new Map(), false).all,
    /hachnasas/,
  );
  assert.equal(
    matchesPlan(
      { ...shiur, title: 'Shacharis' },
      parseSearch('Can I learn about morning prayers?', { scope: 'title' }),
    ),
    true,
  );
});

void test('encoded archive queries stay within the upstream limit without dropping required subjects', () => {
  for (const text of [
    'כיבוד הורים',
    'honoring parents on shabbat',
    'candle lighting and loan interest and counting the omer',
    'ברכת המזון צדקה תפילה שבת חינוך חסד',
  ]) {
    const query = librarySearchQuery(text);
    assert.ok(
      new URLSearchParams({ searchTerm: query }).toString().length <= 1800,
      text,
    );
  }
  const query = librarySearchQuery('hospitality loan interest 613 shabbat');
  for (const word of ['hospitality', 'loan', 'interest', '613', 'shabbat'])
    assert.ok(query.includes(word), word);
});
