import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { routeSearchStorage } from '../lib/search-storage-routing';
import { postgresSearchSql } from '../lib/search-postgres';
import type { SearchDatabase, SearchStatement } from '../lib/search-storage';

function database(schema: string): SearchDatabase {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  class Statement implements SearchStatement {
    constructor(
      readonly sql: string,
      readonly values: SQLInputValue[] = [],
    ) {}
    bind(...values: unknown[]) {
      return new Statement(this.sql, values as SQLInputValue[]);
    }
    async first<T>() {
      return (sqlite.prepare(this.sql).get(...this.values) as T) || null;
    }
    async all<T>() {
      return { results: sqlite.prepare(this.sql).all(...this.values) as T[] };
    }
    async run() {
      return {
        meta: {
          changes: Number(sqlite.prepare(this.sql).run(...this.values).changes),
        },
      };
    }
  }
  return {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

void test('notes snapshots and library caches use independent databases without losing transaction rollback', async () => {
  const library = database('CREATE TABLE search_runs(id TEXT PRIMARY KEY)');
  const notes = database(
    'CREATE TABLE search_notes_state(name TEXT PRIMARY KEY)',
  );
  const db = routeSearchStorage(library, notes);
  await db.prepare('INSERT INTO search_runs VALUES(?)').bind('library').run();
  await db.batch([
    db.prepare('INSERT INTO search_notes_state VALUES(?)').bind('notes'),
  ]);
  assert.equal(
    (await db.prepare('SELECT id FROM search_runs').first<{ id: string }>())
      ?.id,
    'library',
  );
  assert.equal(
    (
      await db
        .prepare('SELECT name FROM search_notes_state')
        .first<{ name: string }>()
    )?.name,
    'notes',
  );
  await assert.rejects(
    db.batch([
      db.prepare('INSERT INTO search_notes_state VALUES(?)').bind('rollback'),
      db.prepare('INSERT INTO search_notes_state VALUES(?)').bind('notes'),
    ]),
    /UNIQUE/,
  );
  assert.equal(
    await db
      .prepare('SELECT name FROM search_notes_state WHERE name=?')
      .bind('rollback')
      .first(),
    null,
  );
});

void test('mixed transactions and joins fail before either database is changed', async () => {
  const library = database('CREATE TABLE search_runs(id TEXT PRIMARY KEY)');
  const notes = database(
    'CREATE TABLE search_notes_state(name TEXT PRIMARY KEY)',
  );
  const db = routeSearchStorage(library, notes);
  await assert.rejects(
    db.batch([
      db.prepare('INSERT INTO search_runs VALUES(?)').bind('library'),
      db.prepare('INSERT INTO search_notes_state VALUES(?)').bind('notes'),
    ]),
    /cannot span/,
  );
  assert.equal(
    await library.prepare('SELECT id FROM search_runs').first(),
    null,
  );
  assert.equal(
    await notes.prepare('SELECT name FROM search_notes_state').first(),
    null,
  );
  assert.throws(
    () => db.prepare('SELECT * FROM search_runs JOIN search_notes_state'),
    /cannot join/,
  );
});

void test('notes schema checks use the notes connection and retain PostgreSQL schema qualification', async () => {
  const library = database(
    'CREATE TABLE pg_indexes(indexname TEXT,tablename TEXT)',
  );
  const notes = database(
    "CREATE TABLE pg_indexes(indexname TEXT,tablename TEXT); INSERT INTO pg_indexes VALUES('search_note_fulltext','search_note_documents')",
  );
  const db = routeSearchStorage(library, notes);
  assert.ok(
    await db
      .prepare(
        "SELECT indexname FROM pg_indexes WHERE tablename='search_note_documents'",
      )
      .first(),
  );
  assert.equal(
    postgresSearchSql('SELECT key FROM search_note_documents'),
    'SELECT key FROM yutorah_search.search_note_documents',
  );
});
