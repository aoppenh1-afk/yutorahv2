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

test('name suggestions tolerate missing letters while preserving exact matches first', () => {
  assert.equal(suggestSearch('Hershel Schacter', directory)[0].id, 1);
  assert.equal(suggestSearch('Rav Hershel Schachter', directory)[0].id, 1);
  assert.equal(suggestSearch('Shay Schachter', directory)[0].id, 2);
  assert.equal(
    suggestSearch('unrelated astronomical query', directory).length,
    0,
  );
});

test('teacher, topic and series suggestions preserve their entity types', () => {
  assert.equal(suggestSearch('Shabbat', directory)[0].kind, 'topic');
  assert.equal(suggestSearch('Daf Yomi', directory)[0].kind, 'series');
  assert.equal(
    suggestSearch('Schachter', directory).filter((s) => s.kind === 'teacher')
      .length,
    2,
  );
});

test('ambiguous surnames never silently select a teacher', () => {
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

test('ordinary duration, media, and Hebrew topic phrasing produces disclosed filters', () => {
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

test('text normalization and highlighting preserve safe visible text', () => {
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

test('direct title matches rank ahead of incidental description matches', () => {
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
