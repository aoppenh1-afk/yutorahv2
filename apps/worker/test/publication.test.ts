import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import {
  TranscriptionStore,
  profile,
} from '../../../packages/transcription/src/store.js';
import {
  publishPending,
  publicationTarget,
} from '../../../packages/transcription/src/publication.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';
import { publicContent } from '../../../packages/transcription/src/public-content.js';

void test('D1 publication configuration is disabled until complete, and never enables R2', () => {
  assert.equal(publicationTarget({}), undefined);
  assert.throws(
    () => publicationTarget({ TRANSCRIPT_ARCHIVE_ACCOUNT_ID: 'a'.repeat(32) }),
    /Invalid/,
  );
  assert.ok(
    publicationTarget({
      TRANSCRIPT_ARCHIVE_ACCOUNT_ID: 'a'.repeat(32),
      TRANSCRIPT_ARCHIVE_DATABASE_ID: randomUUID(),
      TRANSCRIPT_ARCHIVE_API_TOKEN: 'test-token',
    }),
  );
});
void test(
  'durable outbox retries publication without retranscribing and preserves corrections queued during upload',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'publication_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
      max: 3,
    });
    try {
      for (const f of (await readdir('db/transcription')).sort())
        await pool.query(await readFile('db/transcription/' + f, 'utf8'));
      const writer = new TranscriptionStore(pool);
      const p = profile('Fixture instructions', defaultSettings, 'fixture');
      await writer.enqueue(
        { id: '42', title: 'Fixture', teacher: 'Rabbi Fixture' },
        p,
      );
      const job = await writer.claim();
      assert.ok(job);
      await writer.manifest(job, 'fixture', 'audio', {
        version: 1,
        durationMs: 10000,
        ranges: [{ start: 0, end: 10, coreStart: 0, coreEnd: 10 }],
      });
      await writer.complete(job, {
        schemaVersion: 1,
        durationMs: 10000,
        text: 'Original transcript',
        segments: [
          {
            startMs: 1000,
            endMs: 10000,
            text: 'Original transcript',
            speaker: null,
            language: null,
          },
        ],
      });
      const first = (await pool.query('SELECT * FROM transcript_publications'))
        .rows[0];
      assert.ok(first);
      assert.equal(first.published_generation, '0');
      assert.ok(
        Number(first.generation) > 1,
        'outbox updates supersede an imported generation-1 snapshot',
      );
      const controller = new AbortController();
      assert.equal(
        await publishPending(
          pool,
          {
            publish: async () => {
              throw new Error('quota limit');
            },
          },
          controller.signal,
        ),
        0,
      );
      const retry = (await pool.query('SELECT * FROM transcript_publications'))
        .rows[0];
      assert.equal(retry.attempt, 1);
      assert.equal(retry.error, 'publication_failed');
      assert.equal(
        (await pool.query('SELECT status FROM transcription_jobs')).rows[0]
          .status,
        'completed',
      );
      await pool.query('UPDATE transcript_publications SET available_at=now()');
      assert.equal(
        await publishPending(
          pool,
          {
            publish: async (value) => {
              assert.ok(!('text' in value.content));
              assert.ok(!('cleanedText' in (value.content.notes ?? {})));
              assert.equal(
                publicContent(value.content).createdAt,
                value.content.createdAt,
              );
              await pool.query(
                "UPDATE transcription_shiurim SET title='Corrected title' WHERE id='42'",
              );
              return {
                id: '42',
                generation: value.generation,
                version: 'a'.repeat(64),
                applied: true,
              };
            },
          },
          controller.signal,
        ),
        1,
      );
      const newer = (await pool.query('SELECT * FROM transcript_publications'))
        .rows[0];
      assert.ok(Number(newer.generation) > Number(first.generation));
      assert.equal(
        newer.published_generation,
        '0',
        'a completed old upload never acknowledges a newer correction',
      );
      assert.equal(
        await publishPending(
          pool,
          {
            publish: async (value) => {
              assert.equal(value.content.title, 'Corrected title');
              return {
                id: '42',
                generation: value.generation,
                version: 'b'.repeat(64),
                applied: true,
              };
            },
          },
          controller.signal,
        ),
        1,
      );
      const done = (await pool.query('SELECT * FROM transcript_publications'))
        .rows[0];
      assert.equal(done.generation, done.published_generation);
      await pool.query(
        "UPDATE transcript_segments SET text='Corrected transcript' WHERE shiur_id='42'",
      );
      const corrected = (
        await pool.query('SELECT * FROM transcript_publications')
      ).rows[0];
      assert.ok(Number(corrected.generation) > Number(done.generation));
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
