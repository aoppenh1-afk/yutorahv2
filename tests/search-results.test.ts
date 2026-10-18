import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findCatalogSearchMatches,
  mergeSearchMatches,
  type CatalogSearchMatch,
} from '../lib/search-results';
import { normalize } from '../lib/yutorah';

void test('submitted searches find all catalog types with title matching and keep navigation metadata', () => {
  const directory = {
    teachers: [
      {
        id: 1,
        name: 'Rabbi Hershel Schachter',
        firstName: 'Hershel',
        lastName: 'Schachter',
        count: 4,
        image: '/portrait.jpg',
      },
    ],
    series: [
      {
        id: 2,
        name: 'Hilchos Shabbos',
        count: 10,
        description: '',
        image: '/series.jpg',
      },
    ],
    topics: [{ id: 3, name: 'Shabbos', group: 'Halacha', count: 500 }],
    groups: ['Halacha'],
  };
  assert.equal(
    findCatalogSearchMatches('Hershel Schachter', directory, [], [])[0].image,
    '/portrait.jpg',
  );
  const matches = findCatalogSearchMatches(
    'shabos',
    directory,
    [{ id: 4, name: 'Shabbos', count: 1 }],
    [{ id: 5, name: 'Shabbos Kollel', count: 10 }],
  );
  assert.deepEqual(
    new Set(matches.map((item) => item.kind)),
    new Set(['topic', 'series', 'collection', 'venue']),
  );
  assert.equal(
    matches.find((item) => item.kind === 'series')?.image,
    '/series.jpg',
  );
  assert.deepEqual(
    findCatalogSearchMatches('unrelated astronomy', directory, [], []),
    [],
  );
  assert.deepEqual(findCatalogSearchMatches('', directory, [], []), []);
});

void test('actual results use the same title accuracy for recordings and pages in either direction', () => {
  const exact = normalize({ shiurID: 1, shiurTitle: 'Hilchos Shabbos' });
  const broad: CatalogSearchMatch = {
    kind: 'collection',
    id: 4,
    name: 'Hilchos Shabbos: An Introduction',
    count: 50000,
  };
  assert.equal(
    mergeSearchMatches([exact], [broad], 'Hilchos Shabbos')[0].kind,
    'shiur',
  );
  const result = mergeSearchMatches(
    [{ ...exact, title: broad.name }],
    [{ ...broad, name: exact.title }],
    'Hilchos Shabbos',
  );
  assert.equal(result[0].kind, 'page');
  assert.equal(result.length, 2);
});

void test('a catalog page remains a result when no individual shiur matches', () => {
  const page: CatalogSearchMatch = {
    kind: 'venue',
    id: 7,
    name: 'Yeshiva University',
    count: 5,
  };
  assert.deepEqual(mergeSearchMatches([], [page], 'Yeshiva University'), [
    { kind: 'page', page },
  ]);
});

void test('mixing more than eight results does not keep the dropdown limit or duplicate entities', () => {
  const pages: CatalogSearchMatch[] = Array.from({ length: 65 }, (_, id) => ({
    kind: 'series',
    id,
    name: 'Hilchos Shabbos',
    count: 1,
  }));
  const result = mergeSearchMatches(
    [],
    [...pages, pages[0]],
    'Hilchos Shabbos',
  );
  assert.equal(result.length, 65);
});

void test('recording-specific sorting retains the existing order when pages are filtered out', () => {
  const items = [
    normalize({ shiurID: 2, shiurTitle: 'Zebra' }),
    normalize({ shiurID: 1, shiurTitle: 'Alpha' }),
  ];
  assert.deepEqual(
    mergeSearchMatches(items, [], 'Alpha', 'new').map(
      (item) => item.kind === 'shiur' && item.shiur.id,
    ),
    [2, 1],
  );
});
