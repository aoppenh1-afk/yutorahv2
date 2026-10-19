import { parseArgs } from 'node:util';
import { postgresSearchPool } from '../lib/search-postgres';

const { values } = parseArgs({
  options: { days: { type: 'string', default: '32' } },
});
const days = Number(values.days);
if (!Number.isSafeInteger(days) || days < 1 || days > 62)
  throw new Error('Choose 1–62 days.');
if (!process.env.SEARCH_DATABASE_URL)
  throw new Error('Set SEARCH_DATABASE_URL to the library runtime connection.');
const pool = postgresSearchPool(process.env.SEARCH_DATABASE_URL);
try {
  const { rows } = await pool.query(
    `SELECT day::text,database,feature,queries,rows,column_bytes AS "columnBytes",errors
    FROM yutorah_search.database_transfer_daily WHERE day >= (now() AT TIME ZONE 'UTC')::date - ($1::int-1)
    ORDER BY day,database,column_bytes DESC`,
    [days],
  );
  console.log(
    JSON.stringify(
      {
        measurement:
          'PostgreSQL column payload bytes; excludes protocol/TLS and accounting writes',
        days,
        groups: rows,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
