import test from 'node:test';
import assert from 'node:assert/strict';

const origin = process.env.TEST_ORIGIN || 'http://localhost:3001';
async function json(path) {
  const response = await fetch(new URL(path, origin), {
    signal: AbortSignal.timeout(45000),
  });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  let result = await response.json();
  if (path.startsWith('/api/search')) {
    const url = new URL(path, origin);
    let passes = 0;
    while (result.complete === false) {
      assert.ok(++passes <= 200, 'Search did not finish');
      url.searchParams.set('run', result.run);
      const next = await fetch(url, { signal: AbortSignal.timeout(45000) });
      assert.equal(next.status, 200);
      result = await next.json();
    }
  }
  return result;
}

void test('homepage has real, actionable content', async () => {
  const home = await json('/api/home');
  assert.ok(home.total > 400000);
  assert.ok(home.featured.length && home.recent.length && home.daily.length);
  assert.ok(home.series.every((s) => s.count > 0));
  for (const shiur of [...home.featured, ...home.recent, ...home.daily]) {
    assert.ok(shiur.id > 0 && shiur.title && shiur.teacher);
    assert.match(shiur.url, /^https:\/\/yutorah.org\//);
  }
});

void test('compound search resolves teacher and duration beyond title text', async () => {
  const result = await json(
    '/api/search?q=' +
      encodeURIComponent('teshuva by Rabbi Hershel Schachter under 30 minutes'),
  );
  assert.equal(result.plan.teacherId, 80153);
  assert.equal(result.plan.max, 30);
  assert.equal(result.plan.term, 'teshuva');
  assert.ok(result.items.length > 0);
  assert.ok(
    result.items.every(
      (s) => s.teacherId === 80153 && s.duration > 0 && s.duration <= 1800,
    ),
  );
  assert.ok(
    result.items.some((s) => !/teshuv/i.test(s.title)),
    'Search reaches indexed metadata beyond titles',
  );
});

void test('pagination advances through distinct live results', async () => {
  const first = await json('/api/search?q=teshuva');
  assert.ok(first.nextPage > 1);
  const second = await json('/api/search?q=teshuva&page=' + first.nextPage);
  assert.ok(first.items.length && second.items.length);
  assert.notDeepEqual(
    first.items.map((s) => s.id),
    second.items.map((s) => s.id),
  );
});

void test('question search resolves a disclosed topic', async () => {
  const result = await json(
    '/api/search?q=' + encodeURIComponent('How can I improve my prayer?'),
  );
  assert.equal(result.plan.term, 'tefillah');
  assert.ok(result.plan.labels.includes('Topic: tefillah'));
  assert.ok(result.total > 0);
});

void test('shiur details expose playable media, video, and real source materials', async () => {
  const shiur = await json('/api/shiur?id=1187437');
  assert.equal(shiur.id, 1187437);
  assert.ok(shiur.duration > 0);
  assert.match(shiur.audio, /^https:\/\//);
  assert.match(shiur.video, /youtu/);
  assert.ok(shiur.materials.length > 0);
  assert.ok(
    shiur.materials.every((m) => m.name && m.url.startsWith('https://')),
  );
  const media = await fetch(shiur.audio, {
    headers: { Range: 'bytes=0-1023' },
    signal: AbortSignal.timeout(30000),
  });
  assert.ok([200, 206].includes(media.status));
  assert.match(media.headers.get('content-type') || '', /audio|octet-stream/);
  await media.body?.cancel();
});

void test('invalid requests return usable client errors', async () => {
  for (const path of [
    '/api/shiur?id=invalid',
    '/api/shiur',
    '/api/search?q=' + 'a'.repeat(301),
  ]) {
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});
