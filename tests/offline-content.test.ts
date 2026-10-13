import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchStudy,
  saveOfflineContent,
  cachedPortrait,
  STUDY_CACHE,
  PORTRAIT_CACHE,
  removeOfflineContent,
} from '../lib/offline-content';
import { AUDIO_CACHE, offlineAudioPath } from '../lib/download-contract';
import type { Shiur } from '../lib/yutorah';

const origin = 'https://yutorah.test';
function environment() {
  const stores = new Map<string, Map<string, Response>>();
  let quotaFailure = false;
  const key = (input: RequestInfo | URL) =>
    new URL(input instanceof Request ? input.url : String(input), origin).href;
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async put(input: RequestInfo | URL, response: Response) {
          if (quotaFailure && name !== AUDIO_CACHE)
            throw new DOMException('Full', 'QuotaExceededError');
          store.set(key(input), response.clone());
        },
        async match(input: RequestInfo | URL) {
          return store.get(key(input))?.clone();
        },
        async delete(input: RequestInfo | URL) {
          return store.delete(key(input));
        },
        async keys() {
          return [...store.keys()].map((url) => new Request(url));
        },
      };
    },
  };
  const navigator = { onLine: true };
  const window = { caches, __YUTORAH_OFFLINE__: false };
  for (const [name, value] of Object.entries({
    caches,
    navigator,
    window,
    location: { origin },
  }))
    Object.defineProperty(globalThis, name, { configurable: true, value });
  return {
    caches,
    stores,
    navigator,
    window,
    failQuota() {
      quotaFailure = true;
    },
  };
}
const transcript = (text: string) => ({
  id: '1',
  transcriptId: 'fixture',
  segments: [{ startMs: 0, endMs: 1000, text, speaker: null }],
  notes: null,
});
const shiur = {
  id: 1,
  image: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/rebbe_o.jpg',
} as Shiur;
async function audio(env: ReturnType<typeof environment>, id = 1) {
  await (
    await env.caches.open(AUDIO_CACHE)
  ).put(offlineAudioPath(id), new Response('audio'));
}

void test('study browsing does not persist content until the shiur is downloaded', async () => {
  const env = environment();
  globalThis.fetch = async () => Response.json(transcript('Public transcript'));
  await fetchStudy('/api/transcript?id=1');
  assert.equal(env.stores.get(STUDY_CACHE)?.size, 0);
  await audio(env);
  await fetchStudy('/api/transcript?id=1');
  env.navigator.onLine = false;
  globalThis.fetch = async () => {
    throw new Error('Must not fetch offline');
  };
  assert.equal(
    (await (await fetchStudy('/api/transcript?id=1&fresh=true')).json())
      .segments[0].text,
    'Public transcript',
  );
  await assert.rejects(
    fetchStudy('/api/account-library?id=1'),
    /Invalid study/,
  );
  await assert.rejects(
    fetchStudy('https://another.test/api/transcript?id=1'),
    /Invalid study/,
  );
});

void test('network failures and queued notes never replace completed offline notes', async () => {
  const env = environment();
  await audio(env);
  globalThis.fetch = async () =>
    Response.json({ status: 'completed', markdown: 'Saved notes' });
  await fetchStudy('/api/study-notes?id=1');
  for (const fetcher of [
    async () => Response.json({ status: 'queued', markdown: null }),
    async () => Response.json({ error: 'Unavailable' }, { status: 503 }),
    async () => {
      throw new TypeError('Network failed');
    },
  ]) {
    globalThis.fetch = fetcher;
    assert.equal(
      (await (await fetchStudy('/api/study-notes?id=1')).json()).markdown,
      'Saved notes',
    );
  }
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    fetchStudy('/api/study-notes?id=1', { signal: abort.signal }),
    { name: 'AbortError' },
  );
});

void test('portrait fallback is stored once and shared across rebbe image variants', async () => {
  const env = environment();
  await audio(env);
  await audio(env, 2);
  let images = 0;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/_images/')) {
      images++;
      return url.includes('_lp.')
        ? new Response(null, { status: 404 })
        : new Response('image', { headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (url.includes('official-study'))
      return Response.json({
        available: true,
        summary: 'Summary',
        chapters: [],
      });
    if (url.includes('study-notes'))
      return Response.json({ status: 'completed', markdown: 'Notes' });
    return Response.json(transcript('Transcript'));
  };
  const signal = new AbortController().signal;
  const first = await saveOfflineContent(shiur, signal);
  assert.equal(first.image, true);
  assert.equal(first.transcript, true);
  assert.equal(first.notes, true);
  assert.equal(first.summary, true);
  const second = { ...shiur, id: 2, image: shiur.image.replace('_o.', '.') };
  await saveOfflineContent(second, signal);
  assert.equal(images, 2);
  assert.equal(env.stores.get(PORTRAIT_CACHE)?.size, 1);
  await removeOfflineContent(1, [second]);
  assert.ok(await cachedPortrait(second.image));
  assert.equal((await (await env.caches.open(STUDY_CACHE)).keys()).length, 3);
});

void test('unavailable content and quota failures leave audio intact and report no saved extras', async () => {
  const env = environment();
  await audio(env);
  env.failQuota();
  globalThis.fetch = async (input) =>
    (input instanceof Request ? input.url : input.toString()).includes(
      '/_images/',
    )
      ? new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })
      : Response.json(transcript('A live transcript'));
  const status = await saveOfflineContent(shiur, new AbortController().signal);
  assert.equal(status.image, false);
  assert.equal(status.transcript, false);
  assert.equal(status.notes, false);
  assert.equal(status.summary, false);
  assert.ok(
    await (await env.caches.open(AUDIO_CACHE)).match(offlineAudioPath(1)),
  );
  assert.equal(
    (await (await fetchStudy('/api/transcript?id=1')).json()).segments[0].text,
    'A live transcript',
  );
  env.navigator.onLine = false;
  assert.equal((await fetchStudy('/api/transcript?id=1')).status, 404);
});

void test('oversized and malformed study responses never overwrite a saved transcript', async () => {
  const env = environment();
  await audio(env);
  globalThis.fetch = async () =>
    Response.json(transcript('Keep this transcript'));
  await fetchStudy('/api/transcript?id=1');
  for (const body of [
    'broken JSON',
    JSON.stringify(transcript('x'.repeat(8 * 1024 * 1024))),
  ]) {
    globalThis.fetch = async () =>
      new Response(body, { headers: { 'Content-Type': 'application/json' } });
    assert.equal(
      (await (await fetchStudy('/api/transcript?id=1')).json()).segments[0]
        .text,
      'Keep this transcript',
    );
  }
});
