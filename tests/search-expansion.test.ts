import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRelevanceScorer } from '../packages/yutorah-core/src/search-ranking.js';
import {
  matchQuery,
  librarySearchQuery,
  wordMatch,
  teacherWordMatch,
  searchRetrieval,
  textMatchEvidence,
  textMatchScore,
  queryVocabulary,
} from '../lib/search-matching.js';
import {
  parseSearch,
  matchesPlan,
  normalize,
  type Directory,
} from '../lib/yutorah.js';
import { teacherMention } from '../lib/search-discovery.js';

const corpus = JSON.parse(
  readFileSync('tests/fixtures/search-relevance.json', 'utf8'),
) as { query: string; relevant: string[]; distractors: string[] }[];
const document = (title: string, description = '') => ({
  title,
  description,
  topics: [],
  series: '',
  teacher: '',
});
void test('expanded search finds the intended subjects and ranks them above close distractors', () => {
  const failures: string[] = [];
  for (const entry of corpus) {
    const plan = parseSearch(entry.query, { scope: 'title' });
    const score = createRelevanceScorer(plan.term);
    const ranked = [...entry.distractors, ...entry.relevant]
      .map((title) => ({
        title,
        score: score(document(title)),
        matches: matchesPlan(normalize({ shiurid: 1, shiurtitle: title }), plan),
      }))
      .sort((a, b) => b.score - a.score);
    if (!entry.relevant.includes(ranked[0].title) || !ranked[0].matches)
      failures.push(
        `${entry.query} → ${plan.term}: ${ranked[0].title}, matched=${ranked[0].matches}`,
      );
    const compiled = librarySearchQuery(plan.term);
    assert.ok(
      new URLSearchParams({ searchTerm: compiled }).toString().length <= 1800,
      entry.query,
    );
  }
  assert.deepEqual(failures, []);
});

void test('reliable metadata beats an unrelated fuzzy title and title density breaks broad ties', () => {
  const score = createRelevanceScorer('kidney donation');
  assert.ok(
    score(document('Medical Ethics', 'Kidney donation and transplantation')) >
      score(document('Kidney Donating')),
  );
  const broad = 'Coffee Tea Biscuits Dress Travel Work and Shabbos';
  const compact = 'Coffee and Shabbos';
  const topical = createRelevanceScorer('coffee shabbos');
  assert.ok(topical(document(compact)) > topical(document(broad)));
  assert.ok(
    topical(document(broad)) > topical(document('Coffee Coffee Coffee')),
  );
});

void test('transliteration candidates remain weaker than exact words and never change literals or numbers', () => {
  assert.equal(wordMatch('schachter', 'shakhter'), 0.72);
  assert.equal(wordMatch('schachter', 'schachter'), 1);
  assert.equal(wordMatch('613', '614'), 0);
  assert.equal(wordMatch('eruv', 'erev'), 0);
  assert.ok(
    wordMatch('cooking', 'caking') < 0.72,
    'Ordinary edit-distance tolerance must not receive a transliteration boost',
  );
  assert.equal(
    searchRetrieval('schachter', ['shakhter'], true).strictQuery,
    'schachter',
  );
  assert.equal(
    parseSearch('"schachter"', { literal: true }).phrase,
    'schachter',
  );
  assert.ok(!matchQuery('Astronomy', 'kiddushin'));
});

void test('teacher aliases resolve only an unambiguous full name or explicit surname', () => {
  const directory = {
    teachers: [
      {
        id: 1,
        name: 'Rabbi Tzvi Sobolofsky',
        firstName: 'Tzvi',
        lastName: 'Sobolofsky',
        count: 1,
        image: '',
      },
      {
        id: 2,
        name: 'Rabbi Hershel Schachter',
        firstName: 'Hershel',
        lastName: 'Schachter',
        count: 1,
        image: '',
      },
      {
        id: 3,
        name: 'Rabbi Shay Schachter',
        firstName: 'Shay',
        lastName: 'Schachter',
        count: 1,
        image: '',
      },
    ],
    topics: [],
    series: [],
    groups: [],
  } satisfies Directory;
  assert.equal(teacherWordMatch('zvi', 'tzvi'), 0.94);
  assert.equal(
    teacherMention('by Rav Zvi Sobolofski', directory)?.teacher.id,
    1,
  );
  assert.equal(
    teacherMention('by Rav Herschel Shakhter', directory)?.teacher.id,
    2,
  );
  assert.equal(teacherMention('by Rav Shakhter', directory), null);
  assert.equal(
    parseSearch('Shabbos by Rav Herschel Shakhter', {}, directory).teacherId,
    2,
  );
});

void test('compiled scoring agrees with positional evidence across repeated and related terms', () => {
  for (const entry of corpus)
    for (const title of [...entry.relevant, ...entry.distractors]) {
      const hits = textMatchEvidence(title, entry.query);
      assert.equal(
        textMatchScore(title, entry.query),
        Math.max(0, ...hits.map((hit) => hit.score)),
      );
    }
  const score = createRelevanceScorer('coffee shabbos');
  assert.ok(
    Number.isFinite(score(document('Coffee '.repeat(2000) + 'Shabbos'))),
  );
});

void test('run vocabulary is bounded while exact words and frequency ordering survive', () => {
  const vocabulary = [
    'quantum',
    ...Array.from({ length: 4000 }, (_, i) => `quantumword${i}`),
    'halacha',
  ];
  const snapshot = queryVocabulary('quantum halacha', vocabulary);
  assert.ok(snapshot.length <= 64);
  assert.ok(snapshot.includes('quantum'));
  assert.ok(snapshot.includes('halacha'));
  assert.deepEqual(queryVocabulary('complint', ['compliant', 'complaint']), [
    'compliant',
    'complaint',
  ]);
});
