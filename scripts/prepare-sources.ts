import { parseArgs } from 'node:util';
import { appendFile } from 'node:fs/promises';
import {
  postgresSearchDatabase,
  postgresSearchPool,
} from '../lib/search-postgres';
import { runSourcePreparation } from '../lib/source-preparation';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    url: {
      type: 'string',
      default: process.env.SOURCES_SITE_URL || 'https://yutorah.vercel.app',
    },
    ids: { type: 'string', default: '' },
    'max-minutes': { type: 'string', default: '20' },
    'max-jobs': { type: 'string', default: '60' },
    'catalog-pages': { type: 'string', default: '2' },
    check: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(`Prepare verified mekoros using the existing detector on this computer.

  npm run sources:prepare -- [options]

  --url URL          Website supplying published transcripts, notes, and feature flags
  --ids 123,456      Queue specific shiurim immediately
  --max-minutes 20   Stop after a bounded run; checkpoints survive on the database
  --max-jobs 60      Maximum shiur attempts in this run
  --catalog-pages 2  Latest page plus resumable archive discovery; 0 disables discovery
  --check            Read-only check of database access and the sources table

Set SOURCES_DATABASE_URL to the website's writable search database connection.
No local AI model, TiDB writer, transcript writer, or Sefaria key is needed.`);
} else {
  const connection = process.env.SOURCES_DATABASE_URL;
  if (!connection)
    throw new Error(
      'Set the SOURCES_DATABASE_URL secret to the website search database connection.',
    );
  const pool = postgresSearchPool(connection);
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Preparation interrupted.'));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let summary = '';
  try {
    const db = postgresSearchDatabase(pool);
    await db
      .prepare('SELECT id,payload,lease,expires FROM sources_runs LIMIT 0')
      .all();
    if (values.check)
      summary = 'Source preparation database connection and schema verified.';
    else {
      const result = await runSourcePreparation({
        db,
        site: new URL(values.url!),
        signal: abort.signal,
        maxRuntimeMs: Number(values['max-minutes']) * 60000,
        maxJobs: Number(values['max-jobs']),
        catalogPages: Number(values['catalog-pages']),
        ids: values.ids ? values.ids.split(',').map((id) => id.trim()) : [],
        // Connect cancellation to API work too, keeping each request's own timeout.
        fetcher: (url, init) =>
          fetch(url, {
            ...init,
            signal: AbortSignal.any([
              abort.signal,
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
        report: (event) => console.log(JSON.stringify(event)),
      });
      summary = `Source preparation: ${JSON.stringify(result)}\nResults and queue checkpoints are saved in the shared database.`;
      if (result.outcome === 'upstream-unavailable') process.exitCode = 1;
    }
    console.log(summary);
  } catch {
    // Database/provider errors may contain credentials. Keep CI logs to a fixed message.
    summary =
      'Source preparation could not finish. Check database access, published inputs, and upstream availability. Saved checkpoints will be reused.';
    console.error(summary);
    process.exitCode = 1;
  } finally {
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await pool.end();
  }
}
