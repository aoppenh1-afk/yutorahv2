import { Pool } from 'pg';
import { serveSearch } from '../../../lib/content-server.js';
import { TranscriptionStore } from '../../../packages/transcription/src/store.js';
const pool = new Pool({
  connectionString:
    process.env.TRANSCRIPT_DATABASE_URL ?? process.env.DATABASE_URL,
  max: 2,
});
const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => abort.abort());
try {
  await serveSearch(
    new TranscriptionStore(pool),
    process.env.TRANSCRIPT_API_TOKEN ?? '',
    Number(process.env.TRANSCRIPT_API_PORT ?? process.env.PORT ?? 8765),
    abort.signal,
  );
} finally {
  await pool.end();
}
