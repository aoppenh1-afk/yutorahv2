import { Buffer } from 'node:buffer';
import { Pool, type PoolClient, type QueryResult } from 'pg';

export type TransferDatabase = 'library' | 'notes';
export type TransferFeature =
  | 'charts'
  | 'catalog'
  | 'artwork'
  | 'vocabulary'
  | 'search_results'
  | 'search_state'
  | 'sources'
  | 'notes_index'
  | 'control'
  | 'other';
export type TransferCount = {
  feature: TransferFeature;
  queries: number;
  rows: number;
  columnBytes: number;
  errors: number;
};
export type TransferReporter = (counts: TransferCount[]) => Promise<void>;

export function transferPool(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 1000,
    query_timeout: 1000,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
  pool.on('error', () =>
    console.warn(
      JSON.stringify({ event: 'database_transfer_connection_lost' }),
    ),
  );
  return pool;
}

/** Fixed labels only. Neither SQL, parameters, IDs nor returned values leave this module. */
export function transferFeature(
  sql: string,
  params: unknown[] = [],
): TransferFeature {
  if (/\bcatalog_snapshots\b/.test(sql)) return 'catalog';
  if (/\bcatalog_artwork\b/.test(sql)) return 'artwork';
  if (/\bsources_runs\b/.test(sql)) return 'sources';
  if (/\bsearch_notes?_/.test(sql)) return 'notes_index';
  if (
    /\bsearch_title_|\bspelling_candidates\b|\binsert_spelling_keys\b/.test(sql)
  )
    return 'vocabulary';
  if (
    /\bsearch_runs\b/.test(sql) &&
    params.some(
      (value) => typeof value === 'string' && value.startsWith('trending:v1:'),
    )
  )
    return 'charts';
  if (/\bsearch_(?:hits|documents)\b/.test(sql)) return 'search_results';
  if (/\bsearch_runs\b/.test(sql)) return 'search_state';
  if (
    /^(?:BEGIN|COMMIT|ROLLBACK)\b|pg_advisory_|\b(?:catalog_refresh_leases|search_(?:pass_guards|creation_leases|cache_usage))\b/.test(
      sql,
    )
  )
    return 'control';
  return 'other';
}

/** Query-local parsers count the UTF-8 column bytes before decoding. Delegating
 * to this client's parser preserves its bigint/JSON/date and custom types.
 * Protocol framing, authentication and TLS bytes are deliberately not estimated. */
export async function transferQuery(
  client: PoolClient,
  sql: string,
  params: unknown[],
  counts: Map<TransferFeature, TransferCount>,
): Promise<QueryResult> {
  const feature = transferFeature(sql, params);
  let count = counts.get(feature);
  if (!count)
    counts.set(
      feature,
      (count = { feature, queries: 0, rows: 0, columnBytes: 0, errors: 0 }),
    );
  count.queries++;
  const current = count;
  try {
    const result = await client.query({
      text: sql,
      values: params,
      types: {
        getTypeParser(oid, format) {
          const parse = client.getTypeParser(oid, format);
          return (value: string | Buffer) => {
            current.columnBytes += Buffer.isBuffer(value)
              ? value.length
              : Buffer.byteLength(value);
            return parse(value);
          };
        },
      },
    });
    current.rows += result.rows.length;
    return result;
  } catch (error) {
    current.errors++;
    throw error;
  }
}

/** Persist small daily counters on the library connection, including notes
 * reads through their read-only connection. The caller releases its transaction
 * first, so accounting also works with a one-connection pool. A meter failure
 * never changes a completed read/write or triggers a retry of application work. */
export function transferReporter(
  pool: Pool,
  database: TransferDatabase,
  schema = 'yutorah_search',
): TransferReporter {
  if (!/^[a-z][a-z0-9_]*$/.test(schema))
    throw new TypeError('Invalid transfer schema.');
  let retryAt = 0;
  return async (counts) => {
    if (!counts.length) return;
    for (const count of counts)
      console.log(
        JSON.stringify({
          event: 'database_transfer',
          version: 1,
          database,
          ...count,
        }),
      );
    if (Date.now() < retryAt) return;
    try {
      await pool.query(
        `WITH expired AS (DELETE FROM ${schema}.database_transfer_daily WHERE day < (now() AT TIME ZONE 'UTC')::date - 62)
        INSERT INTO ${schema}.database_transfer_daily(day,database,feature,queries,rows,column_bytes,errors)
        SELECT (now() AT TIME ZONE 'UTC')::date,$1,feature,queries,rows,"columnBytes",errors
        FROM jsonb_to_recordset($2::jsonb) AS c(feature text,queries bigint,rows bigint,"columnBytes" bigint,errors bigint)
        ON CONFLICT(day,database,feature) DO UPDATE SET queries=database_transfer_daily.queries+excluded.queries,
        rows=database_transfer_daily.rows+excluded.rows,column_bytes=database_transfer_daily.column_bytes+excluded.column_bytes,
        errors=database_transfer_daily.errors+excluded.errors`,
        [database, JSON.stringify(counts)],
      );
    } catch {
      retryAt = Date.now() + 30000;
      console.warn(
        JSON.stringify({
          event: 'database_transfer_store_unavailable',
          database,
        }),
      );
    }
  };
}
