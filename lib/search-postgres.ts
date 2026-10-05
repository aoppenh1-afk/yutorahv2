import { Pool, types, type QueryResult } from 'pg';
import type { SearchDatabase, SearchStatement } from './search-storage';

const identifiers = new Set([
  'sources_runs',
  'search_runs',
  'search_hits',
  'search_title_catalog',
  'search_title_terms',
  'search_title_keys',
  'search_title_word_keys',
  'insert_spelling_keys',
  'spelling_candidates',
  'search_title_cursors',
  'search_title_imports',
  'json_extract',
  'json_each',
  'instr',
]);

/** Translate the small SQL vocabulary of the shared search module. Values
 * remain bound parameters; quoted text is never rewritten or interpolated. */
export function postgresSearchSql(sql: string, schema = 'yutorah_search') {
  if (!/^[a-z][a-z0-9_]*$/.test(schema))
    throw new TypeError('Invalid search schema.');
  let source = sql.trim().replace(/;$/, '');
  // Resolve keys in one SQL statement rather than invoking the logical view's
  // insert trigger for every key in a search page.
  if (
    /^INSERT OR IGNORE INTO search_title_keys \(key,term\)\s+SELECT json_extract\(value,'\$\[0\]'\),json_extract\(value,'\$\[1\]'\) FROM json_each\(\?\)$/i.test(
      source,
    )
  )
    source = 'SELECT insert_spelling_keys(?)';
  if (
    /^WITH requested AS \(/i.test(source) &&
    source.includes('JOIN search_title_keys k') &&
    source.includes('position <= 64')
  )
    source = 'SELECT term,words,documents FROM spelling_candidates(?)';
  if (source.includes('__search_quote_'))
    throw new TypeError('Reserved search SQL identifier.');
  const quoted: string[] = [];
  source = source.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, (literal) => {
    const index = quoted.push(literal) - 1;
    return `__search_quote_${index}__`;
  });
  const ignore = /^INSERT OR IGNORE INTO /i.test(source);
  const keyInsert = /^INSERT OR IGNORE INTO search_title_keys\b/i.test(source);
  if (ignore)
    source = source.replace(/^INSERT OR IGNORE INTO /i, 'INSERT INTO ');
  source = source
    .replace(
      /GROUP BY r\.slot,t\.term/g,
      'GROUP BY r.slot,t.term,t.words,t.documents',
    )
    .replace(/CASE WHEN \? THEN/g, 'CASE WHEN ? <> 0 THEN')
    .replace(/\bword\.value\b/g, "(word.value #>> '{}')")
    .replace(
      /json_extract\((value|payload),\s*__search_quote_(\d+)__\)/g,
      (expression, column: string, index: string) => {
        if (column === 'value' && quoted[Number(index)] === "'$.slot'")
          return `(${expression})::integer`;
        if (column === 'payload' && quoted[Number(index)] === "'$.views'")
          return `(${expression})::double precision`;
        return expression;
      },
    );
  let parameter = 0;
  const translated = source.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|\?|\b[a-zA-Z_][a-zA-Z_0-9]*\b/g,
    (token) => {
      if (token === '?') return '$' + ++parameter;
      return identifiers.has(token.toLowerCase())
        ? `${schema}.${token}`
        : token;
    },
  );
  return (
    translated.replace(
      /__search_quote_(\d+)__/g,
      (_, index: string) => quoted[Number(index)],
    ) + (ignore && !keyInsert ? ' ON CONFLICT DO NOTHING' : '')
  );
}

function safeNumber(value: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new RangeError('Search number exceeds the supported range.');
  return number;
}

export function postgresSearchPool(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 8000,
    query_timeout: 15000,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
    types: {
      getTypeParser: (oid, format) =>
        oid === 20 ? safeNumber : types.getTypeParser(oid, format),
    },
  });
  pool.on('error', () => console.error('Search database connection lost.'));
  return pool;
}

/** The same resumable search transactions on managed PostgreSQL. The runtime
 * role needs access only to its search schema, not transcription or admin data. */
export function postgresSearchDatabase(
  pool: Pool,
  schema = 'yutorah_search',
): SearchDatabase {
  const result = (query: QueryResult) => ({
    results: query.rows,
    meta: { changes: query.rowCount ?? 0 },
  });
  class Statement implements SearchStatement {
    constructor(
      readonly sql: string,
      readonly params: unknown[] = [],
    ) {}
    bind(...params: unknown[]) {
      if (
        params.some(
          (value) =>
            value !== null && !['string', 'number'].includes(typeof value),
        )
      )
        throw new TypeError('Unsupported search storage parameter.');
      return new Statement(this.sql, params);
    }
    async all<T = Record<string, unknown>>() {
      const query = await pool.query(this.sql, this.params);
      return { ...result(query), results: query.rows as T[] };
    }
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      return (await this.all<T>()).results[0] ?? null;
    }
    async run() {
      return result(await pool.query(this.sql, this.params));
    }
  }
  return {
    dialect: 'postgres',
    prepare(sql) {
      return new Statement(postgresSearchSql(sql, schema));
    },
    async batch(statements) {
      if (statements.some((statement) => !(statement instanceof Statement)))
        throw new TypeError('Search statement belongs to another database.');
      if (!statements.length) return [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Title frequencies share rows across otherwise independent queries.
        // Serialize these small writes to avoid lock-order deadlocks.
        if (
          (statements as Statement[]).some(
            (s) =>
              s.sql.includes(`${schema}.search_title_catalog`) ||
              s.sql.includes(`${schema}.search_title_keys`),
          )
        )
          await client.query(
            'SELECT pg_advisory_xact_lock(1790900494,hashtext($1))',
            [schema],
          );
        const results = [];
        for (const statement of statements as Statement[])
          results.push(
            result(await client.query(statement.sql, statement.params)),
          );
        await client.query('COMMIT');
        return results;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

let database: SearchDatabase | undefined;
export function managedSearchDatabase() {
  if (!database) {
    if (!process.env.SEARCH_DATABASE_URL)
      throw new Error('Search storage is not configured.');
    database = postgresSearchDatabase(
      postgresSearchPool(process.env.SEARCH_DATABASE_URL),
    );
  }
  return database;
}
