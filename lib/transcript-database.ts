import { Pool } from 'pg';
import { TranscriptionStore } from '../packages/transcription/src/store';
import {
  createCachedTranscriptReader,
  type TranscriptReader,
} from '../packages/transcription/src/read-cache';

let store: TranscriptionStore | undefined;
const readers = new WeakMap<TranscriptReader, TranscriptReader>();

/** A small server-side pool using the website's read-only database role. */
function databaseReader() {
  if (!store) {
    const pool = new Pool({
      connectionString: process.env.TRANSCRIPT_DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 8000,
      query_timeout: 8000,
      idleTimeoutMillis: 10000,
      allowExitOnIdle: true,
    });
    pool.on('error', () =>
      console.error('Transcript database connection lost.'),
    );
    store = new TranscriptionStore(pool);
  }
  return store;
}

export async function transcriptDatabaseGateway(
  path: string,
  params: URLSearchParams,
  reader?: TranscriptReader,
): Promise<Response> {
  const reply = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: {
        'Cache-Control':
          status === 200
            ? `public, max-age=0, s-maxage=${path === '/v1/transcripts/search' ? 15 : 60}`
            : 'no-store',
      },
    });
  try {
    const raw = reader ?? databaseReader();
    let source = readers.get(raw);
    if (!source) {
      source = createCachedTranscriptReader(raw);
      readers.set(raw, source);
    }
    const id = path.match(/^\/v1\/transcripts\/(\d{1,12})$/)?.[1];
    if (id) {
      const content = await source.content(id);
      return content
        ? reply(content)
        : reply({ error: 'No completed transcript yet.' }, 404);
    }
    if (path !== '/v1/transcripts/search')
      return reply({ error: 'Not found.' }, 404);
    const query = params.get('q') || '';
    const mode = params.get('mode') || 'smart';
    const limit = Number(params.get('limit') || 20);
    if (
      !query.trim() ||
      query.length > 200 ||
      !['phrase', 'terms', 'smart'].includes(mode) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      return reply({ error: 'Try different search words.' }, 400);
    return reply({
      results: await source.search(
        query,
        params.get('aliases') !== 'false',
        limit,
        mode as 'phrase' | 'terms' | 'smart',
      ),
    });
  } catch {
    return reply({ error: 'Transcripts are temporarily unavailable.' }, 503);
  }
}
