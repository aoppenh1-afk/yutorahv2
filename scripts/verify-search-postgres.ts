import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

// psql COPY output has the same stable escaping as the audited source export.
// Passwords are passed in the child's environment, never in argv or logs.
const [auditPath, reportPath] = process.argv.slice(2);
if (!auditPath || !reportPath || !process.env.SEARCH_MIGRATION_DATABASE_URL)
  throw new Error(
    'Set SEARCH_MIGRATION_DATABASE_URL; pass SOURCE.audit.json REPORT.json.',
  );
const url = new URL(process.env.SEARCH_MIGRATION_DATABASE_URL);
const password = decodeURIComponent(url.password);
url.password = '';
const source = JSON.parse(readFileSync(auditPath, 'utf8')) as {
  tables: {
    table: string;
    columns: string[];
    order: string;
    count: number;
    hash: string;
  }[];
};
const reports = [];
for (const expected of source.tables) {
  if (
    !/^search_title_[a-z]+$/.test(expected.table) ||
    !expected.columns.every((x) => /^[a-z]+$/.test(x)) ||
    !/^[a-z,]+$/.test(expected.order)
  )
    throw new Error('Invalid source audit.');
  // String keys use byte ordering to match SQLite's binary ordering.
  const order = expected.order
    .split(',')
    .map((x) => (x === 'id' ? x : `${x} COLLATE "C"`))
    .join(',');
  const sql = `COPY (SELECT ${expected.columns.join(',')} FROM yutorah_search.${expected.table} ORDER BY ${order}) TO STDOUT`;
  const child = spawn(
    'psql',
    [
      '-X',
      '--no-password',
      '--set=ON_ERROR_STOP=on',
      '--dbname',
      url.toString(),
      '--command',
      sql,
    ],
    {
      env: {
        ...globalThis.process.env,
        PGPASSWORD: password,
        PGSSLROOTCERT: '/etc/ssl/certs/ca-certificates.crt',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const hash = createHash('sha256');
  let count = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    for (const byte of chunk) if (byte === 10) count++;
  });
  // Drain errors, but don't echo connection diagnostics containing credentials.
  child.stderr.resume();
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (exit) throw new Error(`Search audit failed for ${expected.table}.`);
  const digest = hash.digest('hex');
  const match = count === expected.count && digest === expected.hash;
  reports.push({ table: expected.table, count, hash: digest, match });
  console.log(JSON.stringify({ table: expected.table, count, match }));
  if (!match) throw new Error(`Search data differs for ${expected.table}.`);
}
writeFileSync(reportPath, JSON.stringify(reports, null, 2), { mode: 0o600 });
