import { spawn } from 'node:child_process';

// Requires the PostgreSQL client tools and a migration/owner connection.
// COPY refuses a nonempty search destination; existing transcripts are untouched.
const [copyPath] = process.argv.slice(2);
if (!copyPath || !process.env.SEARCH_MIGRATION_DATABASE_URL)
  throw new Error(
    'Set SEARCH_MIGRATION_DATABASE_URL and pass the prepared COPY.sql.',
  );
const url = new URL(process.env.SEARCH_MIGRATION_DATABASE_URL);
const password = decodeURIComponent(url.password);
url.password = '';
const child = spawn(
  'psql',
  [
    '-X',
    '--no-password',
    '--set=ON_ERROR_STOP=on',
    '--dbname',
    url.toString(),
    '--file=db/search-postgres/001_search.sql',
    '--file=' + copyPath,
  ],
  {
    env: {
      ...process.env,
      PGPASSWORD: password,
      PGSSLROOTCERT: '/etc/ssl/certs/ca-certificates.crt',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
const code = await new Promise<number | null>((resolve, reject) => {
  child.on('error', reject);
  child.on('close', resolve);
});
if (code !== 0)
  throw new Error(
    'Search import failed; the COPY transaction was rolled back.',
  );
