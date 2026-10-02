import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import {
  cleanFillerWords,
  cleanTranscript,
} from '../../../packages/transcription/src/cleanup.js';
import { transcribeChunks } from '../../../packages/transcription/src/engine.js';
import { indexedSegments } from '../../../packages/transcription/src/search-index.js';
import {
  TranscriptionStore,
  profile,
} from '../../../packages/transcription/src/store.js';
import { SessionPool } from '../../../packages/antigravity-acp/src/pool.js';
import {
  defaultSettings,
  type Segment,
} from '../../../packages/transcription/src/types.js';

const segment = (text: string, startMs = 0): Segment => ({
  text,
  startMs,
  endMs: startMs + 1000,
  speaker: 'Rabbi',
  language: null,
});

void test('cleanup removes hesitation sounds and tidies punctuation without rewriting content', () => {
  for (const [input, expected] of [
    ['Um, we, uh, learn Torah.', 'we, learn Torah.'],
    ['Ummm... The גמרא says, umm, this.', 'The גמרא says, this.'],
    ['We um learn uhhh Torah erm today.', 'We learn Torah today.'],
    ['Um, uh, erm.', ''],
    ['We learn, um.', 'We learn.'],
    ['Um\nתורה', 'תורה'],
    ['We (um) learn.', 'We learn.'],
    ['He said "Um, we learn."', 'He said "we learn."'],
  ]) {
    assert.equal(cleanFillerWords(input), expected, input);
    assert.equal(cleanFillerWords(expected), expected, 'idempotence');
  }
});

void test('meaningful words, responses, quotations, acronyms and Unicode word boundaries survive', () => {
  const text =
    'Ah, oh, er, hmm, like, so, well, you know, I mean. uh-huh uh-uh uh-oh nuh-uh chumash umami drum serum UM UHM "um" “uh” \'um\' אum umא uḿ';
  assert.equal(cleanFillerWords(text), text);
  assert.equal(
    cleanFillerWords('Natural  spacing\n\nתורה.'),
    'Natural  spacing\n\nתורה.',
  );
});

void test('filler-only segments disappear while surviving timestamps and metadata stay exact', () => {
  const original = {
    schemaVersion: 1 as const,
    durationMs: 3000,
    text: 'original',
    segments: [
      segment('Um.'),
      segment('תורה, uh, today.', 1000),
      segment('Uh...', 2000),
    ],
  };
  const result = cleanTranscript(original);
  assert.deepEqual(result.segments, [
    { ...original.segments[1], text: 'תורה, today.' },
  ]);
  assert.equal(result.text, 'תורה, today.');
  assert.equal(original.segments[0].text, 'Um.');
  assert.deepEqual(cleanTranscript(result), result);
});

void test('saved raw chunks are cleaned on resume without reuploading or modifying checkpoints', async () => {
  const raw = [segment('Um.'), segment('We learn, uh, תורה.', 1000)];
  const result = await transcribeChunks({
    ranges: [{ start: 0, end: 3, coreStart: 0, coreEnd: 3 }],
    durationMs: 3000,
    settings: defaultSettings,
    pool: new SessionPool(1),
    signal: new AbortController().signal,
    checkpoints: {
      load: async () => raw,
      save: async () => assert.fail('saved checkpoint must stay untouched'),
    },
    transcribe: async () => assert.fail('no new audio call'),
  });
  assert.equal(result.text, 'We learn, תורה.');
  assert.equal(result.segments[0].startMs, 1000);
  assert.equal(raw[0].text, 'Um.');
});

void test('all-filler audio cannot publish an empty transcript', async () => {
  await assert.rejects(
    transcribeChunks({
      ranges: [{ start: 0, end: 1, coreStart: 0, coreEnd: 1 }],
      durationMs: 1000,
      settings: defaultSettings,
      pool: new SessionPool(1),
      signal: new AbortController().signal,
      checkpoints: { load: async () => [segment('Um.')], save: async () => {} },
      transcribe: async () => assert.fail('saved'),
    }),
    { code: 'invalid_transcript' },
  );
});

void test(
  'PostgreSQL cleanup backs up, rolls back, reindexes search, and is idempotent',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'cleanup_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    try {
      for (const migration of [
        '001_initial',
        '002_catalog_cursor',
        '003_tolerant_search',
        '004_operator_notes',
      ])
        await pool.query(
          await readFile(`db/transcription/${migration}.sql`, 'utf8'),
        );
      const store = new TranscriptionStore(pool);
      await store.enqueue(
        { id: '123', title: 'Example', teacher: 'Rabbi' },
        profile('skill', defaultSettings, 'test'),
      );
      const job = (await store.claim())!;
      await store.manifest(job, 'fingerprint', 'audio', {
        version: 1,
        durationMs: 3000,
        ranges: [{ start: 0, end: 3, coreStart: 0, coreEnd: 3 }],
      });
      const raw = [
        segment('We learn'),
        segment('Um.', 1000),
        segment('Torah, uh, today.', 2000),
      ];
      await store
        .checkpoints(job, 'fingerprint')
        .save(0, { start: 0, end: 3, coreStart: 0, coreEnd: 3 }, raw);
      await store.complete(job, {
        schemaVersion: 1,
        durationMs: 3000,
        text: 'stale',
        segments: raw,
      });
      const published = (await store.content('123'))!;
      assert.equal(published.text, 'We learn\n\nTorah, today.');
      assert.equal(published.segments.length, 2);
      // Simulate a legacy record with raw text, including a filler-only segment.
      await pool.query(
        'DELETE FROM transcript_segments WHERE transcript_id=$1',
        [published.transcriptId],
      );
      for (const row of indexedSegments(raw))
        await pool.query(
          'INSERT INTO transcript_segments(transcript_id,shiur_id,segment_index,start_ms,end_ms,speaker,language,text,search_text,search_window) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            published.transcriptId,
            '123',
            row.segment_index,
            row.start_ms,
            row.end_ms,
            row.speaker,
            row.language,
            row.text,
            row.search_text,
            row.search_window,
          ],
        );
      const rawText = raw.map((s) => s.text).join('\n\n');
      await pool.query('UPDATE transcripts SET text=$2 WHERE id=$1', [
        published.transcriptId,
        rawText,
      ]);
      assert.deepEqual(await store.cleanExistingTranscripts(), {
        scanned: 1,
        changed: 1,
        removedSegments: 1,
        applied: false,
      });
      assert.equal((await store.content('123'))!.text, rawText);
      await assert.rejects(
        store.cleanExistingTranscripts({
          backup: async () => {
            throw new Error('disk full');
          },
        }),
        /disk full/,
      );
      assert.equal((await store.content('123'))!.text, rawText);
      let backedUp = false;
      const report = await store.cleanExistingTranscripts({
        backup: async (original) => {
          backedUp = true;
          assert.equal(original.transcript.text, rawText);
          assert.equal(original.segments.length, 3);
          assert.equal(
            (await store.content('123'))!.text,
            rawText,
            'backup precedes writes',
          );
        },
      });
      assert.equal(backedUp, true);
      assert.equal(report.changed, 1);
      const content = (await store.content('123'))!;
      assert.equal(content.transcriptId, published.transcriptId);
      assert.equal(content.text, published.text);
      assert.deepEqual(content.segments, published.segments);
      assert.equal(
        (await store.search('learn Torah', false, 20, 'phrase')).length,
        1,
      );
      assert.deepEqual(
        await store.cleanExistingTranscripts({
          backup: async () => assert.fail('unchanged'),
        }),
        { scanned: 1, changed: 0, removedSegments: 0, applied: true },
      );
      assert.deepEqual(
        await store
          .checkpoints(job, 'fingerprint')
          .load(0, { start: 0, end: 3, coreStart: 0, coreEnd: 3 }),
        raw,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
