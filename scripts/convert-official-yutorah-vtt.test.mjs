import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVtt, stageTranscript } from './convert-official-yutorah-vtt.mjs';

test('preserves Hebrew, multiline speech, millisecond timings, and overlapping cues', () => {
  const result = stageTranscript(
    '1190357',
    '\uFEFFWEBVTT\r\n\r\n1\r\n00:00:00.000 --> 00:00:10.460\r\nRabbi: שָׁלוֹם\r\nSecond line.\r\n\r\n2\r\n00:00:10.419 --> 00:00:15.039\r\nברכה\r\n',
  );
  assert.deepEqual(result.transcript.segments, [
    {
      startMs: 0,
      endMs: 10460,
      text: 'Rabbi: שָׁלוֹם\nSecond line.',
      speaker: null,
      language: null,
    },
    {
      startMs: 10419,
      endMs: 15039,
      text: 'ברכה',
      speaker: null,
      language: 'he',
    },
  ]);
  assert.equal(result.transcript.durationMs, 15039);
});

test('reads chapter bounds independently of rounded UI values and sentence times', () => {
  const result = stageTranscript(
    '42',
    'WEBVTT\n\n00:00.000 --> 09:03.360\nWords\n',
    'WEBVTT\n\nchapter-one\n00:00:00.000 --> 00:09:03.360\nTeshuvah\n\nchapter-two\n00:09:03.659 --> 00:13:41.919\nTahara\n',
  );
  assert.equal(result.chapters[0].endMs, 543360);
  assert.equal(result.chapters[1].startMs, 543659);
});

test('ignores WebVTT notes and cue layout settings without treating them as speech', () => {
  assert.deepEqual(
    parseVtt(
      'WEBVTT\n\nNOTE source metadata\n00:00:00.000 --> 00:00:01.000\n\n00:00:02.000 --> 00:00:03.000 align:start\nSpeech\n',
    ),
    [{ startMs: 2000, endMs: 3000, text: 'Speech' }],
  );
});

test('distinguishes a missing transcript from an HTML challenge and rejects both for staging', () => {
  assert.deepEqual(parseVtt('WEBVTT\r\n\r\n'), []);
  assert.throws(
    () => stageTranscript('42', 'WEBVTT\r\n\r\n'),
    /No transcript cues/,
  );
  assert.throws(
    () => parseVtt('<html>Just a moment...</html>'),
    /Expected WebVTT/,
  );
});

test('rejects malformed timestamps and reversed cue timing', () => {
  for (const timing of [
    '00:60:00.000 --> 01:00:01.000',
    '00:00:02.000 --> 00:00:01.000',
    '00:00:00.00 --> 00:00:01.000',
  ])
    assert.throws(() => parseVtt(`WEBVTT\n\n${timing}\nWords\n`));
  assert.throws(
    () =>
      parseVtt(
        'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nFirst\n\n00:00:01.000 --> 00:00:02.000\nSecond\n',
      ),
    /invalid WebVTT cue/,
  );
});
