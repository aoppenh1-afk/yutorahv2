import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedTopicGroups } from '../lib/topic-groups';

void test('subject ordering follows the requested sequence and preserves other subjects', () => {
  const source = [
    'Mishna',
    'History',
    'Gemara',
    'Halacha',
    'Yerushalmi',
    'Machshava',
    'Holidays',
    'Nach',
    'Parsha',
    'Midrash',
    'Personalities',
  ];
  assert.deepEqual(orderedTopicGroups(source), [
    'Gemara',
    'Mishna',
    'Parsha',
    'Holidays',
    'Machshava',
    'Halacha',
    'Yerushalmi',
    'Nach',
    'Midrash',
    'Personalities',
    'History',
  ]);
  assert.equal(
    source[0],
    'Mishna',
    'Ordering does not mutate a cached upstream directory',
  );
  assert.deepEqual(
    orderedTopicGroups(['History', 'New subject', 'Gemara', 'Gemara']),
    ['Gemara', 'New subject', 'History'],
  );
});
