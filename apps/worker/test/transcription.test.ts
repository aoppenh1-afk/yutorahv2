import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPool } from '../../../packages/antigravity-acp/src/pool.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import { runProcess } from '../../../packages/antigravity-acp/src/process.js';
import {
  fingerprint,
  hashFile,
} from '../../../packages/transcription/src/fingerprint.js';
import {
  planRanges,
  quietestBoundary,
  validRanges,
  MAX_AUDIO_BYTES,
} from '../../../packages/transcription/src/planning.js';
import {
  parseTranscript,
  mergeBoundary,
} from '../../../packages/transcription/src/transcript.js';
import {
  transcribeChunks,
  chunkTimeout,
} from '../../../packages/transcription/src/engine.js';
import {
  defaultSettings,
  type Range,
  type Segment,
} from '../../../packages/transcription/src/types.js';
import {
  inspectAudio,
  exportChunk,
  prepareRanges,
} from '../../../packages/transcription/src/audio.js';
import {
  searchVariants,
  normalizeTranscriptSearch,
} from '../../../packages/yutorah-core/src/search.js';
import {
  mediaURL,
  publicIPv4,
} from '../../../packages/yutorah-core/src/media.js';

const signal = () => new AbortController().signal;
const ranges = (n: number): Range[] =>
  Array.from({ length: n }, (_, i) => ({
    start: i * 10,
    end: (i + 1) * 10,
    coreStart: i * 10,
    coreEnd: (i + 1) * 10,
  }));
function checkpoints() {
  const parts = new Map<number, Segment[]>();
  return {
    parts,
    load: async (i: number) => parts.get(i) ?? null,
    save: async (i: number, _r: Range, s: Segment[]) => {
      parts.set(i, s);
    },
  };
}
void test('size planning retains complete cores and five-second overlap', () => {
  const plan = planRanges(55_884_344, 3335.253333);
  assert.equal(plan.length, 4);
  assert.ok(validRanges(plan, 3335.253333));
  for (const [i, r] of plan.entries()) {
    assert.ok(
      ((r.end - r.start) * 55_884_344) / 3335.253333 <= MAX_AUDIO_BYTES,
    );
    if (i) assert.equal(r.coreStart - r.start, 5);
    if (i < 3) assert.equal(r.end - r.coreEnd, 5);
  }
  const high = planRanges(100_000_000, 1);
  assert.ok(
    high.every((r) => (r.end - r.start) * 100_000_000 < MAX_AUDIO_BYTES),
  );
  assert.equal(
    quietestBoundary(10, [
      { time: 8, rms: 0.5 },
      { time: 10, rms: 1 },
      { time: 12, rms: 0 },
    ]),
    12,
  );
});
void test('timestamp validation precedes normalization and supports mixed script and quiet endings', () => {
  const segments = parseTranscript(
    '[00:03] Rabbi: The גמ׳ says מיגו.\n[00:02] Student: רש״י?',
    10_000,
    defaultSettings,
  );
  assert.equal(segments[1].startMs, 3000);
  assert.equal(segments[0].speaker, 'Rabbi');
  assert.equal(segments[0].language, null);
  assert.equal(segments[1].language, 'he');
  assert.equal(segments[1].endMs, 10_000);
  for (const text of [
    '',
    'untimed text',
    'Preamble\n[00:01] Hello',
    '[00:08] A\n[00:01] B',
    '[00:50] Beyond',
    '[00:99] Invalid',
  ]) {
    assert.throws(
      () => parseTranscript(text, 10_000, defaultSettings),
      Failure,
    );
  }
  assert.equal(
    parseTranscript('[00:01] Sparse speech.', 60_000, defaultSettings).length,
    1,
  );
});
void test('boundary merge trims only confident overlap and retains later repeated speech', () => {
  const s = (text: string, startMs: number, endMs: number): Segment => ({
    text,
    startMs,
    endMs,
    speaker: null,
    language: null,
  });
  const merged = mergeBoundary(
    [s('We ask what is מיגו here', 0, 10000)],
    [
      s('what is מיגו here and continue', 5000, 15000),
      s('what is מיגו here', 20000, 30000),
    ],
    10000,
    5000,
  );
  assert.deepEqual(
    merged.map((s) => s.text),
    ['We ask what is מיגו here', 'and continue', 'what is מיגו here'],
  );
  assert.equal(merged[1].startMs, 10000);
});
void test('ten parallel chunks obey the global limit and merge in chronological order', async () => {
  const pool = new SessionPool(3),
    cp = checkpoints();
  let active = 0,
    peak = 0;
  const completion: number[] = [];
  const result = await transcribeChunks({
    ranges: ranges(10),
    durationMs: 100_000,
    settings: defaultSettings,
    checkpoints: cp,
    pool,
    signal: signal(),
    transcribe: async ({ index }) => {
      active++;
      peak = Math.max(peak, active);
      await delay(index < 3 ? (3 - index) * 10 : 2);
      active--;
      completion.push(index);
      return `[00:01] Part${index}.`;
    },
  });
  assert.equal(peak, 3);
  assert.equal(completion[0], 2);
  assert.deepEqual(
    result.segments.map((s) => s.text),
    Array.from({ length: 10 }, (_, i) => `Part${i}.`),
  );
  assert.deepEqual(
    result.segments.map((s) => s.startMs),
    Array.from({ length: 10 }, (_, i) => i * 10_000 + 1000),
  );
});
void test('two shiurim share one pool; queued cancellation never takes a permit', async () => {
  const pool = new SessionPool(2);
  let active = 0,
    peak = 0;
  const transcribe = async () => {
    active++;
    peak = Math.max(peak, active);
    await delay(5);
    active--;
    return '[00:01] Text';
  };
  await Promise.all(
    [0, 1].map(() =>
      transcribeChunks({
        ranges: ranges(4),
        durationMs: 40_000,
        settings: defaultSettings,
        checkpoints: checkpoints(),
        pool,
        signal: signal(),
        transcribe,
      }),
    ),
  );
  assert.equal(peak, 2);
  const single = new SessionPool(1),
    controller = new AbortController();
  const running = single.run(signal(), () => delay(30));
  const waiting = single.run(controller.signal, async () =>
    assert.fail('cancelled waiter ran'),
  );
  controller.abort(new Failure('cancelled'));
  await assert.rejects(waiting, Failure);
  await running;
  await single.run(signal(), async () => {});
});
void test('one retry per failed chunk, no outer multiplication, successful uploads stay saved', async () => {
  for (const code of ['timeout', 'process_exit'] as const) {
    const calls = [0, 0],
      cp = checkpoints();
    await assert.rejects(
      transcribeChunks({
        ranges: ranges(2),
        durationMs: 20_000,
        settings: defaultSettings,
        checkpoints: cp,
        pool: new SessionPool(1),
        signal: signal(),
        retryDelayMs: 1,
        transcribe: async ({ index }) => {
          calls[index]++;
          if (index === 1) throw new Failure(code);
          return '[00:01] Kept';
        },
      }),
      Failure,
    );
    assert.deepEqual(calls, [1, 2]);
    assert.equal(cp.parts.size, 1);
  }
  let calls = 0;
  await assert.rejects(
    transcribeChunks({
      ranges: ranges(1),
      durationMs: 10_000,
      settings: defaultSettings,
      checkpoints: checkpoints(),
      pool: new SessionPool(),
      signal: signal(),
      transcribe: async () => {
        calls++;
        throw new Failure('off_task');
      },
    }),
    Failure,
  );
  assert.equal(calls, 1);
  assert.equal(chunkTimeout(1), 900_000);
  assert.equal(chunkTimeout(10000), 7_200_000);
});
void test('cancellation drains siblings and resume skips an out-of-order accepted chunk', async () => {
  const cp = checkpoints(),
    controller = new AbortController();
  let active = 0;
  await assert.rejects(
    transcribeChunks({
      ranges: ranges(5),
      durationMs: 50_000,
      settings: defaultSettings,
      checkpoints: {
        load: cp.load,
        save: async (...args) => {
          await cp.save(...args);
          controller.abort(new Failure('cancelled'));
        },
      },
      pool: new SessionPool(3),
      signal: controller.signal,
      transcribe: async ({ index, signal }) => {
        active++;
        try {
          if (index !== 2) await delay(1000, undefined, { signal });
          return '[00:01] Accepted2';
        } finally {
          active--;
        }
      },
    }),
    Failure,
  );
  assert.equal(active, 0);
  assert.ok(cp.parts.has(2));
  const calls: number[] = [];
  const result = await transcribeChunks({
    ranges: ranges(5),
    durationMs: 50_000,
    settings: defaultSettings,
    checkpoints: cp,
    pool: new SessionPool(3),
    signal: signal(),
    transcribe: async ({ index }) => {
      calls.push(index);
      return `[00:01] Part${index}`;
    },
  });
  assert.deepEqual(
    calls.sort((a, b) => a - b),
    [0, 1, 3, 4],
  );
  assert.equal(result.segments[2].text, 'Accepted2');
});
void test('fingerprint changes on audio, skill, model, runtime and settings; not temporary paths', () => {
  const input = {
    jobId: 'a',
    shiurId: '1',
    audioHash: 'a',
    durationMs: 10000,
    skillHash: 'skill',
    runtime: '1',
    settings: defaultSettings,
    preparationIdentity: 'ffmpeg1',
  };
  const original = fingerprint(input);
  for (const change of [
    { audioHash: 'b' },
    { skillHash: 'next' },
    { runtime: '2' },
    { durationMs: 9999 },
    { settings: { ...defaultSettings, model: 'next' } },
    { settings: { ...defaultSettings, speakers: false } },
  ]) {
    assert.notEqual(fingerprint({ ...input, ...change }), original);
  }
  assert.equal(fingerprint({ ...input }), original);
});
void test('literal Hebrew normalization, explicit aliases and safe media resolution', () => {
  assert.equal(normalizeTranscriptSearch('רַשִׁ״י'), 'רשי');
  assert.equal(normalizeTranscriptSearch('רש"י'), 'רשי');
  assert.ok(searchVariants('Tosfos').includes('תוס'));
  assert.ok(searchVariants('chazara').includes('חזרה'));
  assert.deepEqual(searchVariants('Rashi', false), ['rashi']);
  assert.equal(
    mediaURL('http://download.yutorah.org/a-.mp3').href,
    'https://download.yutorah.org/a.mp3',
  );
  assert.equal(
    mediaURL('https://pub-118b5aaf6ae949ac8f59a93faec8a3da.r2.dev/a.mp3')
      .hostname,
    'pub-118b5aaf6ae949ac8f59a93faec8a3da.r2.dev',
  );
  for (const url of [
    'https://127.0.0.1/a',
    'https://yutorah.org.evil.test/a',
    'https://u:p@yutorah.org/a',
    'https://pub-unrelated.r2.dev/a.mp3',
  ])
    assert.throws(() => mediaURL(url));
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.2',
    '172.31.1.2',
    '100.64.0.1',
  ])
    assert.equal(publicIPv4(ip), false);
});
void test('FFmpeg prepares a large source into bounded playable AAC chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-audio-'));
  try {
    const source = join(root, 'source.wav');
    await runProcess(
      '/usr/bin/ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo',
        '-t',
        '90',
        source,
      ],
      { cwd: root, signal: signal() },
    );
    const info = await inspectAudio(source, signal());
    const hash = await hashFile(source);
    const plan = await prepareRanges(source, info, signal());
    assert.ok(plan.length > 1);
    for (const [index, range] of plan.entries()) {
      const audio = await exportChunk(
        source,
        info,
        range,
        index,
        plan.length,
        root,
        signal(),
      );
      const exported = await inspectAudio(audio.path, signal());
      assert.ok(exported.bytes < MAX_AUDIO_BYTES);
      assert.equal(exported.mimeType, 'audio/m4a');
      assert.ok(
        Math.abs(exported.durationMs - (range.end - range.start) * 1000) < 250,
      );
    }
    assert.equal(await hashFile(source), hash);
    assert.ok((await readFile(source)).length > 16 * 1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test(
  'twenty-minute audio splits at quiet boundaries, exports the overlaps, and resumes ordered merging',
  { timeout: 120000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-long-audio-'));
    try {
      const source = join(root, 'long.wav');
      await runProcess(
        '/usr/bin/ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=16000',
          '-af',
          "volume=0:enable='between(t,305,308)+between(t,605,608)+between(t,905,908)'",
          '-t',
          '1200',
          source,
        ],
        { cwd: root, signal: signal() },
      );
      const info = await inspectAudio(source, signal());
      const originalHash = await hashFile(source);
      const plan = await prepareRanges(source, info, signal());
      assert.equal(plan.length, 4);
      assert.ok(validRanges(plan, 1200));
      const audioParts: Array<{ path: string; mimeType: string }> = [];
      for (const [index, range] of plan.entries()) {
        if (index < plan.length - 1) {
          const silenceStart = 305 + index * 300;
          assert.ok(
            range.coreEnd > silenceStart && range.coreEnd < silenceStart + 3,
            `boundary ${index} must move from speech to silence`,
          );
          assert.equal(range.end - range.coreEnd, 5);
        }
        if (index) assert.equal(range.coreStart - range.start, 5);
        const audio = await exportChunk(
          source,
          info,
          range,
          index,
          plan.length,
          root,
          signal(),
        );
        const exported = await inspectAudio(audio.path, signal());
        assert.ok(exported.bytes <= MAX_AUDIO_BYTES);
        assert.equal(exported.mimeType, 'audio/m4a');
        assert.ok(
          Math.abs(exported.durationMs - (range.end - range.start) * 1000) <
            250,
        );
        if (index) {
          // The pause at the source boundary must also be present five seconds
          // into the exported chunk, proving its overlap and seek are correct.
          const pcm = await runProcess(
            '/usr/bin/ffmpeg',
            [
              '-nostdin',
              '-v',
              'error',
              '-ss',
              String(range.coreStart - range.start),
              '-i',
              audio.path,
              '-t',
              '0.5',
              '-ac',
              '1',
              '-ar',
              '16000',
              '-f',
              's16le',
              'pipe:1',
            ],
            { cwd: root, signal: signal() },
          );
          assert.ok(pcm.length > 10000);
          let square = 0;
          for (let i = 0; i + 2 <= pcm.length; i += 2)
            square += (pcm.readInt16LE(i) / 32767) ** 2;
          assert.ok(Math.sqrt(square / (pcm.length / 2)) < 0.003);
        }
        audioParts.push(audio);
      }
      const cp = checkpoints();
      const completion: number[] = [];
      const timestamp = (seconds: number) => {
        const value = Math.floor(seconds);
        return `${Math.floor(value / 60)
          .toString()
          .padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
      };
      const shared = {
        ranges: plan,
        durationMs: info.durationMs,
        settings: defaultSettings,
        checkpoints: cp,
        pool: new SessionPool(5),
        signal: signal(),
      };
      const result = await transcribeChunks({
        ...shared,
        transcribe: async ({ index, range }) => {
          assert.ok(
            (await readFile(audioParts[index].path)).length <= MAX_AUDIO_BYTES,
          );
          await delay((plan.length - index) * 20);
          completion.push(index);
          const prefix = index ? 'what is מיגו here and part' : 'Start part';
          return `[00:01] ${prefix}${index}.\n[00:20] what is מיגו here${index < plan.length - 1 ? `\n[${timestamp(range.coreEnd - range.start - 2)}] The גמ׳ asks what is מיגו here` : ''}`;
        },
        onMerging: async () => {
          assert.equal(cp.parts.size, plan.length);
        },
      });
      assert.equal(completion[0], 3);
      assert.deepEqual(
        result.segments.filter((s) => /part\d/.test(s.text)).map((s) => s.text),
        ['Start part0.', 'and part1.', 'and part2.', 'and part3.'],
      );
      assert.deepEqual(
        result.segments
          .filter((s) => /part\d/.test(s.text))
          .map((s) => s.startMs),
        plan.map((range, index) =>
          index ? Math.round(range.coreStart * 1000) : 1000,
        ),
        'chunk-local timestamps must shift onto the complete recording timeline',
      );
      assert.equal(
        result.segments.filter((s) => s.text === 'what is מיגו here').length,
        4,
        'real later repetitions must survive boundary deduplication',
      );
      const resumed = await transcribeChunks({
        ...shared,
        transcribe: async () =>
          assert.fail('accepted long-audio chunks must not be uploaded again'),
      });
      assert.deepEqual(resumed, result);
      assert.equal(await hashFile(source), originalHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
