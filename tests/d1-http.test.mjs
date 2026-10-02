import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['lib/d1-http.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { d1HttpDatabase } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
const config = {
  accountId: 'a'.repeat(32),
  databaseId: '00000000-0000-4000-8000-000000000000',
  token: 'test-only-token',
};

void test('HTTP storage preserves bound values, result shapes, and batch rollback', async (t) => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, text TEXT)');
  t.after(() => sqlite.close());
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(
      url,
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`,
    );
    assert.equal(options.headers.Authorization, `Bearer ${config.token}`);
    assert.equal(options.cache, 'no-store');
    const body = JSON.parse(options.body);
    const queries = body.batch || [body];
    sqlite.exec('BEGIN');
    try {
      const result = queries.map(({ sql, params }) => {
        const statement = sqlite.prepare(sql);
        if (statement.columns().length)
          return {
            success: true,
            results: statement.all(...params),
            meta: { changes: 0 },
          };
        return {
          success: true,
          results: [],
          meta: { changes: Number(statement.run(...params).changes) },
        };
      });
      sqlite.exec('COMMIT');
      return Response.json({ success: true, result });
    } catch {
      sqlite.exec('ROLLBACK');
      return Response.json({ success: false, result: [] });
    }
  });
  const db = d1HttpDatabase(config);
  const text = "תורה 'quoted'; SELECT 1";
  const write = await db
    .prepare('INSERT INTO records VALUES (?, ?)')
    .bind(1, text)
    .run();
  assert.equal(write.meta.changes, 1);
  assert.deepEqual(
    await db.prepare('SELECT * FROM records WHERE id = ?').bind(1).first(),
    { id: 1, text },
  );
  assert.equal(
    await db.prepare('SELECT * FROM records WHERE id = ?').bind(2).first(),
    null,
  );
  await db.batch([
    db.prepare('INSERT INTO records VALUES (?, ?)').bind(2, null),
    db.prepare('INSERT INTO records VALUES (?, ?)').bind(3, 'third'),
  ]);
  await assert.rejects(
    db.batch([
      db.prepare('INSERT INTO records VALUES (?, ?)').bind(4, 'must roll back'),
      db.prepare('INSERT INTO records VALUES (?, ?)').bind(1, 'duplicate'),
    ]),
    /unsuccessful query/,
  );
  assert.equal(
    await db.prepare('SELECT * FROM records WHERE id = 4').first(),
    null,
  );
  assert.equal(
    (await db.prepare('SELECT * FROM records').all()).results.length,
    3,
  );
});

void test('storage rejects failed HTTP responses without exposing credentials', async (t) => {
  const db = d1HttpDatabase(config);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(config.token, { status: 403 }),
  );
  await assert.rejects(db.prepare('SELECT 1').all(), {
    message: 'Search storage request failed (403).',
  });
  assert.throws(
    () => db.prepare('SELECT ?').bind({ unsupported: true }),
    TypeError,
  );
  assert.throws(
    () => db.batch([d1HttpDatabase(config).prepare('SELECT 1')]),
    TypeError,
  );
});

void test('database capacity errors are actionable without logging upstream secrets', async (t) => {
  const db = d1HttpDatabase(config);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        errors: [
          { message: `SQLITE_FULL: database or disk is full ${config.token}` },
        ],
      },
      { status: 400 },
    ),
  );
  await assert.rejects(db.prepare('SELECT 1').all(), {
    message: 'Search storage request failed (400). database size limit.',
  });
});
