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
import { retainPublishedStorage } from '../../../packages/transcription/src/retention.js';
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
  'efficiency migration preserves acknowledged and pending publication generations',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'publication_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    try {
      for (const file of (await readdir('db/transcription')).sort()) {
        if (file === '008_efficiency.sql') continue;
        await pool.query(await readFile('db/transcription/' + file, 'utf8'));
      }
      await pool.query(
        "INSERT INTO transcription_shiurim(id,title,teacher) VALUES('42','Acknowledged','Fixture'),('43','Pending','Fixture')",
      );
      await pool.query(
        "INSERT INTO transcript_publications(shiur_id) VALUES('42'),('43')",
      );
      await pool.query(
        "UPDATE transcript_publications SET published_generation=generation WHERE shiur_id='42'",
      );
      const before = (
        await pool.query(
          'SELECT shiur_id,generation,published_generation FROM transcript_publications ORDER BY shiur_id',
        )
      ).rows;
      await pool.query(
        await readFile('db/transcription/008_efficiency.sql', 'utf8'),
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT shiur_id,generation,published_generation FROM transcript_publications ORDER BY shiur_id',
          )
        ).rows,
        before,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT shiur_id,content_changed FROM transcript_publications ORDER BY shiur_id',
          )
        ).rows,
        [
          { shiur_id: '42', content_changed: false },
          { shiur_id: '43', content_changed: true },
        ],
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
void test(
  'durable outbox retries publication without retranscribing and preserves corrections queued during upload',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
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
      const generationBefore = done.generation;
      await writer.enqueue(
        { id: '42', title: 'Corrected title', teacher: 'Rabbi Fixture' },
        p,
      );
      assert.equal(
        (await pool.query('SELECT generation FROM transcript_publications'))
          .rows[0].generation,
        generationBefore,
        'unchanged ingestion never queues another publication',
      );
      const transcriptId = (await writer.contentStatus('42'))!.transcriptId;
      const notesId = randomUUID();
      await pool.query(
        "INSERT INTO notes_versions VALUES('fixture','fixture','english','fixture','fixture','fixture')",
      );
      await pool.query(
        'INSERT INTO notes_jobs(id,transcript_id,version_id) VALUES($1,$2,$3)',
        [notesId, transcriptId, 'fixture'],
      );
      let fullReads = 0,
        statusUpdates = 0;
      const original = writer.publicContent.bind(writer);
      t.mock.method(
        TranscriptionStore.prototype,
        'publicContent',
        function (
          this: TranscriptionStore,
          ...args: Parameters<TranscriptionStore['publicContent']>
        ) {
          fullReads++;
          return original(...args);
        },
      );
      const statusTarget = {
        publish: async (value: {
          generation: number;
          content: Parameters<typeof publicContent>[0];
        }) => ({
          id: '42',
          generation: value.generation,
          version: 'c'.repeat(64),
          applied: true,
        }),
        updateStatus: async (value: {
          id: string;
          generation: number;
          transcriptId: string;
          notes: { status: string } | null;
        }) => {
          statusUpdates++;
          return {
            id: value.id,
            generation: value.generation,
            version: 'b'.repeat(64),
            applied: false,
          };
        },
      };
      assert.equal(
        await publishPending(pool, statusTarget, controller.signal),
        1,
      );
      for (const status of ['cleaning', 'generating']) {
        await pool.query('UPDATE notes_jobs SET status=$2 WHERE id=$1', [
          notesId,
          status,
        ]);
        assert.equal(
          await publishPending(pool, statusTarget, controller.signal),
          1,
        );
      }
      assert.equal(
        fullReads,
        0,
        'queued/cleaning/generating publication never loads timed text',
      );
      assert.equal(statusUpdates, 3);
      await pool.query(
        'INSERT INTO transcript_notes(id,transcript_id,markdown) VALUES($1,$2,$3)',
        [notesId, transcriptId, '# Notes'],
      );
      await pool.query(
        "UPDATE notes_jobs SET status='completed',cleaned_text='cleanup input',completed_at=now()-interval '8 days' WHERE id=$1",
        [notesId],
      );
      assert.equal(
        await publishPending(pool, statusTarget, controller.signal),
        1,
      );
      assert.equal(fullReads, 1);
      await pool.query(
        "UPDATE transcription_jobs SET completed_at=now()-interval '8 days' WHERE id=$1",
        [job.id],
      );
      await pool.query(
        "INSERT INTO transcription_chunks(job_id,fingerprint,chunk_index,payload,digest) VALUES($1,'fixture',0,'{}','fixture')",
        [job.id],
      );
      const retained = await retainPublishedStorage(pool, true);
      assert.equal(retained.checkpoints, 1);
      assert.equal(retained.cleanedNotes, 1);
      assert.ok((await writer.publicContent('42'))!.notes!.markdown);
      const optionClient = await pool.connect();
      try {
        await optionClient.query(
          await readFile(
            'db/transcription-options/archive_only_search.sql',
            'utf8',
          ),
        );
        assert.ok(await writer.publicContent('42'));
        await optionClient.query(
          await readFile(
            'db/transcription-options/restore_postgres_search.sql',
            'utf8',
          ),
        );
      } finally {
        optionClient.release();
      }
      assert.ok(
        (await writer.search('original')).length,
        'optional index removal is reversible',
      );
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
