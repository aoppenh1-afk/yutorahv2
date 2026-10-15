import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import {
  titleTerms,
  indexTitleStatements,
  refreshSpellingKeys,
  titleVocabulary,
} from '../lib/title-index.js';
import { postgresSearchDatabase } from '../lib/search-postgres.js';
import { compactSearchTitleBatch } from '../lib/search-compaction.js';
import { findShiurSuggestions } from '../lib/shiur-autocomplete.js';

void test(
  'compaction preserves every dictionary count, Unicode exception, spelling key, and transactional title edit',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'compact_' + randomUUID().replaceAll('-', '');
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 2,
    });
    const client = await pool.connect();
    const sql = (text: string) => text.replace(/\byutorah_search\b/g, schema);
    try {
      const files = (await readdir('db/search-postgres'))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      for (const file of files.filter((file) => file < '005'))
        await client.query(
          sql(await readFile('db/search-postgres/' + file, 'utf8')),
        );
      const db = postgresSearchDatabase(pool, schema);
      const titles = [
        'Coffee on Shabbos',
        'תְּפִלָּה וּבְרָכוֹת',
        'Rash״i and Rambam',
        'İSTANBUL Café and ﬁsh',
        'A\u200fB\u2066C',
        'בראשית-פרק א׳',
        'Crème brûlée 123',
        '𐐀𐐁𐐂 and 𐐃𐐄𐐅',
        'שבת\u05c6חול',
        'Alpha '.repeat(82),
        'Châteaux & Straße',
        'ΟΣ ος οσ',
        'א'.repeat(65),
        '𐐀'.repeat(33),
      ].map((title, i) => ({ id: i + 1, title }));
      await db.batch(indexTitleStatements(db, titles));
      // Preserve an existing tokenizer exception exactly, even when an upgraded
      // generator could tokenize its title differently.
      await client.query(
        `UPDATE ${schema}.search_title_catalog SET terms='["legacyexception"]' WHERE id=1`,
      );
      const vocabulary = async () =>
        (
          await client.query(
            `SELECT term,words,documents FROM ${schema}.search_title_terms ORDER BY term COLLATE "C"`,
          )
        ).rows;
      const keys = async () =>
        (
          await client.query(
            `SELECT key,term FROM ${schema}.search_title_keys ORDER BY key COLLATE "C",term COLLATE "C"`,
          )
        ).rows;
      const before = await vocabulary();
      const keysBefore = await keys();
      await client.query(
        sql(
          await readFile(
            'db/search-postgres/005_compact_vocabulary.sql',
            'utf8',
          ),
        ),
      );
      const logical = await client.query(
        `SELECT id,title,terms FROM ${schema}.search_title_catalog ORDER BY id`,
      );
      let cursor = 0,
        compacted = 0,
        exceptions = 0;
      for (;;) {
        const progress = await compactSearchTitleBatch(
          client,
          schema,
          cursor,
          3,
        );
        compacted += progress.compacted;
        exceptions += progress.exceptions;
        cursor = progress.after;
        if (progress.complete) break;
      }
      assert.ok(compacted >= 8);
      assert.ok(exceptions >= 1);
      const after = await client.query(
        `SELECT id,title,COALESCE(terms,${schema}.title_terms(title)) AS terms FROM ${schema}.search_title_catalog ORDER BY id`,
      );
      assert.deepEqual(
        after.rows.map((row) => ({ ...row, terms: JSON.parse(row.terms) })),
        logical.rows.map((row) => ({ ...row, terms: JSON.parse(row.terms) })),
      );
      assert.deepEqual(await vocabulary(), before);
      assert.deepEqual(await keys(), keysBefore);
      assert.equal(
        (await compactSearchTitleBatch(client, schema, cursor)).compacted,
        0,
      );
      // Every new JavaScript list either regenerates identically or is retained.
      for (const record of titles)
        await db.batch(
          indexTitleStatements(db, [
            { id: record.id + 100, title: record.title },
          ]),
        );
      const generated = await client.query(
        `SELECT id,title,COALESCE(terms,${schema}.title_terms(title)) AS terms FROM ${schema}.search_title_catalog WHERE id>100 ORDER BY id`,
      );
      for (const row of generated.rows)
        assert.deepEqual(JSON.parse(row.terms), titleTerms(row.title));
      await db.batch(
        indexTitleStatements(db, [{ id: 500, title: 'Hilkhot Shakhter' }]),
      );
      assert.equal(
        (
          await client.query(
            `SELECT terms FROM ${schema}.search_title_catalog WHERE id=500`,
          )
        ).rows[0].terms,
        null,
      );
      await db.batch(
        indexTitleStatements(db, [{ id: 500, title: 'Revised Vocabulary' }]),
      );
      assert.equal(
        (
          await client.query(
            `SELECT documents FROM ${schema}.search_title_terms WHERE term='shakhter'`,
          )
        ).rows[0].documents,
        0,
      );
      await client.query(
        `DELETE FROM ${schema}.search_title_catalog WHERE id=500`,
      );
      assert.equal(
        (
          await client.query(
            `SELECT documents FROM ${schema}.search_title_terms WHERE term='revised'`,
          )
        ).rows[0].documents,
        0,
      );
      await assert.rejects(
        db.batch([
          ...indexTitleStatements(db, [
            { id: 501, title: 'Rollback Vocabulary' },
          ]),
          db
            .prepare('INSERT INTO search_title_keys(key,term) VALUES(?,?)')
            .bind('v:bad', 'missing'),
        ]),
        /foreign key/,
      );
      assert.equal(
        (
          await client.query(
            `SELECT count(*)::int AS n FROM ${schema}.search_title_catalog WHERE id=501`,
          )
        ).rows[0].n,
        0,
      );
      const index = (
        await client.query(
          `SELECT am.amname FROM pg_class i JOIN pg_namespace n ON n.oid=i.relnamespace JOIN pg_am am ON am.oid=i.relam WHERE n.nspname=$1 AND i.relname='search_title_compact_hash'`,
          [schema],
        )
      ).rows[0];
      assert.equal(index.amname, 'hash');
      await db.batch(
        indexTitleStatements(db, [{ id: 600, title: 'Shakhter' }]),
      );
      await client.query(
        `UPDATE ${schema}.search_title_word_keys SET keys=array_remove(keys,'v:shahter') WHERE term='shakhter'`,
      );
      let afterWord = '';
      for (;;) {
        const progress = await refreshSpellingKeys(db, afterWord, 3);
        afterWord = progress.after;
        if (progress.complete) break;
      }
      assert.ok(
        (await titleVocabulary(db, 'schachter')).words.includes('shakhter'),
      );
      const once = await keys();
      await refreshSpellingKeys(db);
      assert.deepEqual(await keys(), once);
      await db.batch(
        indexTitleStatements(db, [{ id: 700, title: 'Bechira Chofshis' }]),
      );
      assert.equal((await findShiurSuggestions(db, 'free will'))[0].id, 700);
      assert.ok(
        (await titleVocabulary(db, 'coffeeonshabbos')).phrases.includes(
          'coffee on shabbos',
        ),
      );
      // Key-only backfills must respect the same lock as title edits and owner
      // migrations, even after the adapter translates their insert to a function.
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(1790900494,hashtext($1))',
        [schema],
      );
      let finished = false;
      let failure: unknown;
      const backfill = db
        .batch([
          db
            .prepare(
              `INSERT OR IGNORE INTO search_title_keys (key,term)
         SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)`,
            )
            .bind(JSON.stringify([['v:shahter', 'shakhter']])),
        ])
        .then(
          () => {
            finished = true;
          },
          (error: unknown) => {
            finished = true;
            failure = error;
          },
        );
      try {
        await delay(25);
        assert.equal(finished, false);
      } finally {
        await client.query('ROLLBACK');
      }
      await backfill;
      assert.equal(failure, undefined);
    } finally {
      client.release();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  },
);
