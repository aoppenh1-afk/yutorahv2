import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedAudioUrl,
  audioSignature,
  relayAudio,
} from '../lib/audio-download';
import { MAX_DOWNLOAD_BYTES } from '../lib/download-contract';
import type { Shiur } from '../lib/yutorah';
const shiur = {
  audio: 'https://download.yutorah.org/2026/1/1191566/shiur.mp3',
} as Shiur;
const signal = new AbortController().signal;
const audio = new Uint8Array(32);
audio.set(new TextEncoder().encode('ID3'));
const source = (headers: Record<string, string> = {}) =>
  new Response(audio, {
    headers: { 'content-type': 'audio/mpeg', ...headers },
  });
void test('only trusted HTTPS recording hosts are accepted', () => {
  assert.equal(allowedAudioUrl(shiur.audio).hostname, 'download.yutorah.org');
  for (const url of [
    'http://download.yutorah.org/a',
    'https://127.0.0.1/a',
    'https://download.yutorah.org.evil.test/a',
    'https://user@download.yutorah.org/a',
    'https://download.yutorah.org:8443/a',
  ])
    assert.throws(() => allowedAudioUrl(url));
});
void test('a recording is streamed without loading the full upstream body first', async () => {
  let pulls = 0;
  const data = new Uint8Array(1024 * 1024);
  data.set(audio);
  const upstream = new Response(
    new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls <= 9) controller.enqueue(data);
        else controller.close();
      },
    }),
    {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(data.length * 9),
      },
    },
  );
  const result = await relayAudio(shiur, signal, async () => upstream);
  assert.ok(pulls < 9);
  assert.equal(result.headers.get('content-type'), 'audio/mpeg');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await result.arrayBuffer()).byteLength, 9 * 1024 * 1024);
});
void test('redirects are validated before the next request', async () => {
  let requests = 0;
  await assert.rejects(
    relayAudio(shiur, signal, async (_url, options) => {
      requests++;
      assert.equal(options?.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/private' },
      });
    }),
    /Unsupported recording/,
  );
  assert.equal(requests, 1);
});
void test('valid CDN redirects retain the audio body', async () => {
  let requests = 0;
  const result = await relayAudio(shiur, signal, async () =>
    ++requests === 1
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://shiurim.yutorah.net/audio.mp3' },
        })
      : source(),
  );
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), audio);
});
void test('error pages and fake audio are rejected before storing them', async () => {
  await assert.rejects(
    relayAudio(
      shiur,
      signal,
      async () =>
        new Response('<html>Error</html>', {
          headers: { 'content-type': 'text/html' },
        }),
    ),
    /audio recording/,
  );
  await assert.rejects(
    relayAudio(
      shiur,
      signal,
      async () =>
        new Response('<html>Error</html>', {
          headers: { 'content-type': 'audio/mpeg' },
        }),
    ),
    /playable audio/,
  );
  assert.equal(audioSignature(audio), true);
});
void test('oversized and incomplete recordings cannot be marked complete', async () => {
  await assert.rejects(
    relayAudio(shiur, signal, async () =>
      source({ 'content-length': String(MAX_DOWNLOAD_BYTES + 1) }),
    ),
    /too large/,
  );
  const result = await relayAudio(shiur, signal, async () =>
    source({ 'content-length': '100' }),
  );
  await assert.rejects(result.arrayBuffer(), /interrupted/);
});
void test('cancelling the downstream stream cancels the upstream reader', async () => {
  let cancelled = false;
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(audio);
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'audio/mpeg' } },
  );
  const result = await relayAudio(shiur, signal, async () => upstream);
  await result.body!.cancel();
  assert.equal(cancelled, true);
});
