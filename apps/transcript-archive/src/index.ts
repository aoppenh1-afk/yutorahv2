import {
  TranscriptArchive,
  type ArchiveDatabase,
} from '../../../packages/transcription/src/archive';
import { D1ContentObjects } from '../../../packages/transcription/src/d1-content';
import {
  contentCacheControl,
  statusCacheControl,
} from '../../../packages/transcription/src/public-content';

type Env = { DB: ArchiveDatabase; READ_TOKEN: string };
type Context = { waitUntil(promise: Promise<unknown>): void };
type EdgeCache = {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<unknown>;
};

async function authorized(request: Request, token: string) {
  if (!token || token.length < 32) return false;
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const hash = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([hash(header.slice(7)), hash(token)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

const worker = {
  async fetch(request: Request, env: Env, context: Context) {
    const reply = (body: unknown, status = 200, cache = 'no-store') =>
      Response.json(body, {
        status,
        headers: {
          'Cache-Control': cache,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    // Authentication always precedes cache lookup. Only the website holds this
    // read token; the deployed Worker has no publication endpoint or API token.
    if (!(await authorized(request, env.READ_TOKEN)))
      return reply({ error: 'Unauthorized' }, 401);
    if (request.method !== 'GET')
      return reply({ error: 'Method not allowed' }, 405);
    const url = new URL(request.url);
    if (url.pathname === '/health') return reply({ ok: true });
    const archive = new TranscriptArchive(env.DB, new D1ContentObjects(env.DB));
    const cache = (
      globalThis.caches as unknown as { default?: EdgeCache } | undefined
    )?.default;
    const key = new Request(url.toString());
    const fresh = url.searchParams.get('fresh') === 'true';
    try {
      if (!fresh && cache) {
        const cached = await cache.match(key);
        if (cached) return cached;
      }
      let response: Response;
      const statusId = url.pathname.match(
        /^\/v1\/transcripts\/(\d{1,12})\/status$/,
      )?.[1];
      const id = url.pathname.match(/^\/v1\/transcripts\/(\d{1,12})$/)?.[1];
      if (statusId) {
        const status = await archive.status(statusId);
        response = status
          ? reply(status, 200, statusCacheControl)
          : reply({ error: 'No completed transcript yet.' }, 404);
      } else if (id) {
        const version = url.searchParams.get('version') ?? undefined;
        if (version && !/^[a-f0-9]{64}$/.test(version))
          return reply({ error: 'Invalid version' }, 400);
        const body = await archive.contentBody(id, version);
        // The publisher verified this immutable JSON before activating it.
        // Avoid parsing and serializing large transcripts in the 10 ms Worker.
        response = body
          ? new Response(
              body.text.slice(0, -1) + ',"version":"' + body.version + '"}',
              {
                headers: {
                  'Content-Type': 'application/json; charset=utf-8',
                  'X-Content-Type-Options': 'nosniff',
                  ETag: '"' + body.version + '"',
                  'Cache-Control': fresh
                    ? 'no-store'
                    : version
                      ? 'public, max-age=31536000, immutable'
                      : contentCacheControl,
                },
              },
            )
          : reply({ error: 'No completed transcript yet.' }, 404);
      } else if (url.pathname === '/v1/transcripts/search') {
        const q = url.searchParams.get('q') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 20);
        const mode = url.searchParams.get('mode') ?? 'smart';
        if (
          !q.trim() ||
          q.length > 200 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 50 ||
          !['smart', 'phrase', 'terms'].includes(mode)
        )
          return reply({ error: 'Invalid search' }, 400);
        response = reply(
          {
            results: await archive.search(
              q,
              url.searchParams.get('aliases') !== 'false',
              limit,
              mode as 'smart' | 'phrase' | 'terms',
            ),
          },
          200,
          statusCacheControl,
        );
      } else return reply({ error: 'Not found' }, 404);
      if (!fresh && cache && response.ok)
        context.waitUntil(cache.put(key, response.clone()).catch(() => {}));
      return response;
    } catch (error) {
      const invalid = error instanceof Error && /Invalid/.test(error.message);
      console.error(
        JSON.stringify({ event: 'archive_request_failed', operation: 'read' }),
      );
      return reply(
        {
          error: invalid
            ? 'Invalid query.'
            : 'Transcripts are temporarily unavailable.',
        },
        invalid ? 400 : 503,
      );
    }
  },
};
export default worker;
