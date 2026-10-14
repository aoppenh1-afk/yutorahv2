import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOfficialVtt } from '../lib/official-transcript.mjs';

const signal = new AbortController().signal;
const outOfOrder =
  'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nFirst\n\n00:00:01.000 --> 00:00:03.000\nSecond\n';
const fetchResponse = (response) => async () => response;

void test('official transcript transport accepts unordered cues and retains the raw source', async () => {
  assert.equal(
    await fetchOfficialVtt(
      '42',
      signal,
      fetchResponse(new Response(outOfOrder)),
    ),
    outOfOrder,
  );
});

void test('transcript validation errors have a permanent code, including invalid encoding and limits', async () => {
  for (const body of [
    '<html>challenge</html>',
    'WEBVTT\n\nbad timing\nWords\n',
    new Uint8Array([0xff]),
    'x'.repeat(8 * 1024 * 1024 + 1),
    'WEBVTT\n\n' + '00:00:00.000 --> 00:00:01.000\nWords\n\n'.repeat(5001),
  ]) {
    await assert.rejects(
      fetchOfficialVtt('42', signal, fetchResponse(new Response(body))),
      { code: 'invalid_transcript' },
    );
  }
});

void test('missing transcripts stay missing and transport errors stay retryable', async () => {
  for (const response of [
    new Response(null, { status: 404 }),
    new Response(null, { status: 204 }),
    new Response(''),
    new Response('WEBVTT\n\n'),
  ])
    assert.equal(
      await fetchOfficialVtt('42', signal, fetchResponse(response)),
      null,
    );
  const error = new Error('connection reset');
  await assert.rejects(
    fetchOfficialVtt('42', signal, async () => {
      throw error;
    }),
    (e) => e === error && !e.code,
  );
});

void test('HTTP failures preserve status and Retry-After metadata for the pool', async () => {
  for (const status of [429, 503, 500])
    await assert.rejects(
      fetchOfficialVtt(
        '42',
        signal,
        fetchResponse(new Response('', { status })),
      ),
      { status, code: `transcript_http_${status}` },
    );
  await assert.rejects(
    fetchOfficialVtt(
      '42',
      signal,
      fetchResponse(
        new Response('', { status: 502, headers: { 'Retry-After': '180' } }),
      ),
    ),
    { status: 502, retryAfterMs: 180000, retryAfter: '180' },
  );
  await assert.rejects(
    fetchOfficialVtt(
      '42',
      signal,
      fetchResponse(
        new Response('', {
          status: 502,
          headers: { 'Retry-After': 'invalid' },
        }),
      ),
    ),
    (e) => e.retryAfter === 'invalid' && e.retryAfterMs === undefined,
  );
});
