import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDirectory, expandDirectory } from '../lib/directory-payload';
import type { Directory } from '../lib/yutorah';
void test('compact directory lookup preserves teacher identity, portraits, topic hierarchy and full-response compatibility', () => {
  const directory: Directory = {
    teachers: Array.from({ length: 20 }, (_, id) => ({
      id,
      name: 'Rabbi Name ' + id,
      firstName: 'Name',
      lastName: String(id),
      count: 100,
      image: `https://cdn.example.test/images/teachers/${id}.jpg`,
    })),
    series: [
      {
        id: 1,
        name: 'Series',
        description: 'Long description',
        image: 'https://cdn.example.test/images/series/1.jpg',
        count: 30,
      },
    ],
    topics: [
      {
        id: 1,
        name: 'Tefillah',
        count: 10,
        group: 'Halacha',
        branch: 'Orach Chaim',
        path: ['Halacha', 'Orach Chaim', 'Tefillah'],
      },
    ],
    groups: ['Halacha'],
  };
  const compact = compactDirectory(directory);
  const expanded = expandDirectory(compact);
  assert.deepEqual(expanded.teachers, directory.teachers);
  assert.equal(expanded.series[0].image, directory.series[0].image);
  assert.deepEqual(expanded.topics, directory.topics);
  assert.equal(expandDirectory(directory), directory);
  assert.ok(
    JSON.stringify(compact).length < JSON.stringify(directory).length * 0.7,
  );
});
