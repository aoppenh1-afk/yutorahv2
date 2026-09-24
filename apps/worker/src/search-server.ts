import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { TranscriptionStore } from '../../../packages/transcription/src/store.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSearchServer(
  store: Pick<TranscriptionStore, 'search'>,
  token: string,
): Server {
  if (Buffer.byteLength(token) < 32) throw new Failure('configuration');
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    if (!authorized(req.headers.authorization, token)) {
      reply(401, { error: 'Unauthorized' });
      return;
    }
    if (req.method !== 'GET') {
      reply(405, { error: 'Method not allowed' });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      reply(400, { error: 'Invalid request' });
      return;
    }
    if (url.pathname === '/health') {
      reply(200, { ok: true });
      return;
    }
    if (url.pathname !== '/v1/transcripts/search') {
      reply(404, { error: 'Not found' });
      return;
    }
    const query = url.searchParams.get('q') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const mode = url.searchParams.get('mode') ?? 'phrase';
    if (
      !query.trim() ||
      query.length > 200 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !['phrase', 'terms'].includes(mode)
    ) {
      reply(400, { error: 'Invalid search' });
      return;
    }
    try {
      const results = await store.search(
        query,
        url.searchParams.get('aliases') !== 'false',
        limit,
        mode as 'phrase' | 'terms',
      );
      reply(200, { results });
    } catch (error) {
      reply(
        error instanceof Error && error.message === 'Invalid transcript query'
          ? 400
          : 503,
        { error: 'Transcript search is unavailable.' },
      );
    }
  });
}

/** The VM reverse proxy owns TLS; this process accepts only loopback traffic. */
export async function serveSearch(
  store: Pick<TranscriptionStore, 'search'>,
  token: string,
  port: number,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Failure('configuration');
  const server = createSearchServer(store, token);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
