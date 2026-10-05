import { createServer, type Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { TranscriptionStore } from '../../../packages/transcription/src/store.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import { createCachedTranscriptReader } from '../../../packages/transcription/src/read-cache.js';

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(actual, expected);
}

export function createSearchServer(
  store: Pick<TranscriptionStore, 'search'> &
    Partial<
      Pick<TranscriptionStore, 'content' | 'contentStatus' | 'publicContent'>
    >,
  token: string,
): Server {
  if (Buffer.byteLength(token) < 32) throw new Failure('configuration');
  const reader = store.content
    ? createCachedTranscriptReader({
        content: (id) =>
          store.publicContent ? store.publicContent(id) : store.content!(id),
        search: (...args) => store.search(...args),
        contentStatus: store.contentStatus?.bind(store),
      })
    : undefined;
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
    const contentId = url.pathname.match(
      /^\/v1\/transcripts\/(\d{1,12})$/,
    )?.[1];
    if (contentId && store.content) {
      try {
        const content = await reader!.content(
          contentId,
          url.searchParams.get('fresh') === 'true',
        );
        reply(
          content ? 200 : 404,
          content ?? { error: 'No completed transcript yet.' },
        );
      } catch {
        reply(503, { error: 'Transcript is unavailable.' });
      }
      return;
    }
    const statusId = url.pathname.match(
      /^\/v1\/transcripts\/(\d{1,12})\/status$/,
    )?.[1];
    if (statusId && reader?.contentStatus) {
      try {
        const status = await reader.contentStatus(statusId);
        reply(
          status ? 200 : 404,
          status ?? { error: 'No completed transcript yet.' },
        );
      } catch {
        reply(503, { error: 'Transcript is unavailable.' });
      }
      return;
    }
    if (url.pathname !== '/v1/transcripts/search') {
      reply(404, { error: 'Not found' });
      return;
    }
    const query = url.searchParams.get('q') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const mode = url.searchParams.get('mode') ?? 'smart';
    if (
      !query.trim() ||
      query.length > 200 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !['phrase', 'terms', 'smart'].includes(mode)
    ) {
      reply(400, { error: 'Invalid search' });
      return;
    }
    try {
      const results = await (reader ?? store).search(
        query,
        url.searchParams.get('aliases') !== 'false',
        limit,
        mode as 'phrase' | 'terms' | 'smart',
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
  store: Pick<TranscriptionStore, 'search'> &
    Partial<Pick<TranscriptionStore, 'content'>>,
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
