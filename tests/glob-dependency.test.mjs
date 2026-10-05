import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const braces = require('braces');
const glob = require('fast-glob');
const nested = '{'.repeat(3500) + 'a,b' + '}'.repeat(3500);

void test('glob dependency rejects deeply nested input before recursive processing', () => {
  for (const operation of [braces.parse, braces.compile, braces.expand])
    assert.throws(() => operation(nested), /exceeds max depth/);
  for (const maxDepth of [Infinity, 10000])
    assert.throws(() => braces.expand(nested, { maxDepth }), /exceeds max depth/);
});

void test('glob dependency also bounds externally constructed syntax trees', () => {
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    let ast = { type: 'text', value: 'a' };
    for (let i = 0; i < 3500; i++) ast = { type: 'brace', nodes: [ast] };
    assert.throws(() => operation({ type: 'root', nodes: [ast] }), /exceeds max depth/);
  }
});

void test('normal build glob expansion and file matching remain intact', () => {
  assert.deepEqual(braces.expand('a{1..3}b{c,d}'), ['a1bc', 'a1bd', 'a2bc', 'a2bd', 'a3bc', 'a3bd']);
  assert.deepEqual(braces('{a,b{1..2}}'), ['(a|b(1|2))']);
  const directory = mkdtempSync(join(tmpdir(), 'yutorah-glob-'));
  try {
    mkdirSync(join(directory, 'src/nested'), { recursive: true });
    for (const file of ['src/a.js', 'src/nested/b.ts', 'src/nested/ignored.css'])
      writeFileSync(join(directory, file), '');
    assert.deepEqual(glob.sync('src/**/{a,b}.{js,ts}', { cwd: directory }).sort(), ['src/a.js', 'src/nested/b.ts']);
    assert.throws(() => glob.sync(nested, { cwd: directory }), /exceeds max depth/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
