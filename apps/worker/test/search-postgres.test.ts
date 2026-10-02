import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import {
  postgresSearchDatabase,
  postgresSearchPool,
} from '../../../lib/search-postgres.js';
import {
  indexTitleStatements,
  titleVocabulary,
} from '../../../lib/title-index.js';
import { completeSearch } from '../../../lib/complete-search.js';
import { migrateTitleArchive } from '../../../lib/title-migration.js';

void test(
  'PostgreSQL preserves title learning, bound values, transactions, and complete filtered pagination',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = 'search_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const pool = postgresSearchPool(process.env.TEST_DATABASE_URL!);
    const migration = (
      await readFile('db/search-postgres/001_search.sql', 'utf8')
    ).replaceAll('yutorah_search', schema);
    try {
      await admin.query(migration);
      const db = postgresSearchDatabase(pool, schema);
      const quoted = await db
        .prepare("SELECT '?' AS marker, ?::text AS input")
        .bind("quoted ' ?; SELECT 1")
        .first();
      assert.deepEqual(quoted, { marker: '?', input: "quoted ' ?; SELECT 1" });
      assert.equal(
        (await db
          .prepare("SELECT 'CASE WHEN ? THEN word.value' AS literal")
          .first<{ literal: string }>())!.literal,
        'CASE WHEN ? THEN word.value',
      );
      await db.batch(
        indexTitleStatements(db, [
          { id: 9001, title: 'Quantum Halacha' },
          { id: 9002, title: 'Quantum Physics' },
        ]),
      );
      assert.ok(
        (await titleVocabulary(db, 'quantmu')).words.includes('quantum'),
      );
      assert.ok(
        (await titleVocabulary(db, 'quantumhalacha')).phrases.includes(
          'quantum halacha',
        ),
      );
      assert.equal(
        (await db
          .prepare(
            "SELECT documents FROM search_title_terms WHERE term='quantum'",
          )
          .first<{ documents: number }>())!.documents,
        2,
      );
      await db.batch(
        indexTitleStatements(db, [{ id: 9002, title: 'Physics' }]),
      );
      assert.equal(
        (await db
          .prepare(
            "SELECT documents FROM search_title_terms WHERE term='quantum'",
          )
          .first<{ documents: number }>())!.documents,
        1,
      );
      await admin.query(migration);
      assert.equal((await titleVocabulary(db, 'quantmu')).words[0], 'quantum');
      await assert.rejects(
        db.batch([
          ...indexTitleStatements(db, [
            { id: 9003, title: 'Quantum Rollback' },
          ]),
          db
            .prepare('INSERT INTO search_title_keys (key,term) VALUES (?,?)')
            .bind('d:bad', 'missing foreign key'),
        ]),
        /foreign key/,
      );
      assert.equal(
        await db
          .prepare('SELECT id FROM search_title_catalog WHERE id=9003')
          .first(),
        null,
      );
      assert.equal(
        (await db
          .prepare(
            "SELECT documents FROM search_title_terms WHERE term='quantum'",
          )
          .first<{ documents: number }>())!.documents,
        1,
      );

      const records = Array.from({ length: 181 }, (_, i) => ({
        shiurid: i + 1,
        shiurtitle: 'Quantum Halacha' + (i % 17 === 0 ? ' excluded' : ''),
        shiurdescription: 'halacha',
        duration: (i + 1) / 60,
        language: i % 2 ? 'HE' : 'EN',
        shiurdate: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
        mediatypename: 'MP3',
        teacherfullname: 'Rabbi Example',
        teacherid: 1,
        shiurvisitsnum: i === 179 ? 1000000 : i * 10,
      }));
      t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname.includes('/browse/')) return Response.json([]);
        const page = Number(url.searchParams.get('start') || 1);
        return Response.json({
          response: {
            docs: records.slice((page - 1) * 30, page * 30),
            numFound: records.length,
          },
        });
      });
      const options = {
        max: 30,
        scope: 'title',
        language: 'HE',
        phrase: 'quantum',
        exclude: 'excluded',
        sort: 'popular',
      };
      const first = await completeSearch(db, 'halacha', options);
      assert.equal(first.complete, false);
      assert.equal(first.scanned, 120);
      const complete = await completeSearch(
        db,
        'halacha',
        options,
        1,
        first.run,
      );
      const expected = records.filter((_, i) => i % 2 === 1 && i % 17 !== 0);
      assert.equal(complete.complete, true);
      assert.equal(complete.scanned, records.length);
      assert.equal(complete.total, expected.length);
      assert.equal(
        complete.items[0].id,
        180,
        'numeric popularity includes the last upstream page',
      );
      assert.ok(
        complete.items.every(
          (x) => x.language === 'HE' && !x.title.includes('excluded'),
        ),
      );
      const second = await completeSearch(db, 'halacha', options, 2, first.run);
      assert.equal(second.complete, true);
      assert.ok(second.items.length > 0);
      assert.equal(
        second.items.some((x) => complete.items.some((y) => x.id === y.id)),
        false,
      );
      assert.equal(
        (await db
          .prepare('SELECT COUNT(*) AS count FROM search_hits WHERE run=?')
          .bind(first.run)
          .first<{ count: number }>())!.count,
        181,
      );
      const archive = Array.from({ length: 61 }, (_, i) => ({
        shiurid: 90100 + i,
        shiurtitle: 'Archive Vocabulary',
      }));
      const read = async (
        minimum?: number,
        maximum?: number,
        descending = false,
      ) => {
        const docs = archive.filter(
          (x) =>
            minimum === undefined ||
            (x.shiurid >= minimum && x.shiurid <= maximum!),
        );
        return {
          numFound: docs.length,
          docs: (descending ? [...docs].reverse() : docs).slice(0, 30),
        };
      };
      const partial = await migrateTitleArchive(db, 1, 4, read);
      assert.equal(partial.scanned, 30);
      const migrated = await migrateTitleArchive(db, 3, 4, read);
      assert.equal(migrated.complete, true);
      assert.equal(migrated.scanned, 61);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
