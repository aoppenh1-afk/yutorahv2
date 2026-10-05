import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import {
  TranscriptionStore,
  profile,
} from '../../../packages/transcription/src/store.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';
import { transcriptDatabaseGateway } from '../../../lib/transcript-database.js';

void test(
  'the website reads published transcripts and tolerant search through a read-only PostgreSQL connection',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const schema = 'website_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    const readPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public -c default_transaction_read_only=on`,
    });
    try {
      for (const name of (await readdir('db/transcription'))
        .filter((x) => /^\d{3}.*\.sql$/.test(x))
        .sort())
        await pool.query(await readFile(`db/transcription/${name}`, 'utf8'));
      const writer = new TranscriptionStore(pool);
      const reader = new TranscriptionStore(readPool);
      const version = profile(
        'Fixture transcription instructions',
        defaultSettings,
        'fixture',
      );
      await writer.enqueue(
        { id: '900001', title: 'Quantum Halacha', teacher: 'Rabbi Fixture' },
        version,
      );
      const job = await writer.claim();
      assert.ok(job);
      await writer.manifest(job, 'fixture', 'fixture-audio', {
        version: 1,
        durationMs: 10000,
        ranges: [{ start: 0, end: 10, coreStart: 0, coreEnd: 10 }],
      });
      await writer.complete(job, {
        schemaVersion: 1,
        durationMs: 10000,
        text: 'Quantum halacha includes חזרה.',
        segments: [
          {
            startMs: 1000,
            endMs: 10000,
            text: 'Quantum halacha includes חזרה.',
            speaker: null,
            language: null,
          },
        ],
      });
      await writer.enqueue(
        { id: '900002', title: 'Unfinished', teacher: 'Rabbi Fixture' },
        version,
      );
      const content = await transcriptDatabaseGateway(
        '/v1/transcripts/900001',
        new URLSearchParams(),
        reader,
      );
      assert.equal(content.status, 200);
      assert.equal(
        content.headers.get('Cache-Control'),
        'public, max-age=60, s-maxage=3600, stale-while-revalidate=300, stale-if-error=86400',
      );
      assert.equal((await content.json()).segments[0].startMs, 1000);
      const missing = await transcriptDatabaseGateway(
        '/v1/transcripts/900002',
        new URLSearchParams(),
        reader,
      );
      assert.equal(missing.status, 404);
      for (const q of ['quantmu', 'chazara']) {
        const response = await transcriptDatabaseGateway(
          '/v1/transcripts/search',
          new URLSearchParams({ q, mode: 'smart' }),
          reader,
        );
        assert.equal(response.status, 200);
        const { results } = await response.json();
        assert.equal(results.length, 1, q);
        assert.equal(results[0].href, '/?shiur=900001&t=1');
      }
      await assert.rejects(
        readPool.query("UPDATE transcription_shiurim SET title='Forbidden'"),
        /read-only/,
      );
      const invalid = await transcriptDatabaseGateway(
        '/v1/transcripts/search',
        new URLSearchParams({ q: 'quantum', limit: '100000' }),
        reader,
      );
      assert.equal(invalid.status, 400);
    } finally {
      await readPool.end();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

void test('database failures return a stable response without exposing connection details', async () => {
  const fail = async () => {
    throw new Error('private-database-password');
  };
  const response = await transcriptDatabaseGateway(
    '/v1/transcripts/1',
    new URLSearchParams(),
    { content: fail, search: fail },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error: 'Transcripts are temporarily unavailable.',
  });
});
