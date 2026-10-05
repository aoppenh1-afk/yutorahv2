/** Only the website server knows the VM's read token. */
import {
  contentCacheControl,
  statusCacheControl,
} from '../packages/transcription/src/public-content';
export async function transcriptGateway(
  path: string,
  params: URLSearchParams,
  etag?: string,
): Promise<Response> {
  const archive = process.env.TRANSCRIPT_ARCHIVE_URL;
  if (!archive && process.env.TRANSCRIPT_DATABASE_URL) {
    const { transcriptDatabaseGateway } = await import('./transcript-database');
    return transcriptDatabaseGateway(path, params);
  }
  if (!archive && params.has('version'))
    return Response.json(
      { error: 'Versioned transcripts require the transcript archive.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  const base = archive || process.env.TRANSCRIPT_API_URL;
  const token = archive
    ? process.env.TRANSCRIPT_ARCHIVE_READ_TOKEN
    : process.env.TRANSCRIPT_API_TOKEN;
  const unavailable = (message: string, status = 503) =>
    Response.json(
      { error: message },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  if (!base || !token)
    return unavailable('Transcript search is not configured yet.');
  let target: URL;
  try {
    target = new URL(path, base);
    if (
      target.username ||
      target.password ||
      !(
        target.protocol === 'https:' ||
        (target.protocol === 'http:' && target.hostname === '127.0.0.1')
      )
    )
      throw new Error('Invalid transcript endpoint');
    target.search = params.toString();
  } catch {
    return unavailable('Transcript search is not configured yet.');
  }
  try {
    const upstream = await fetch(target, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      signal: AbortSignal.timeout(8000),
      // workerd rejects an explicit "default" cache mode.
      ...(params.get('fresh') === 'true' ? { cache: 'no-store' as const } : {}),
    });
    if (upstream.status === 304)
      return new Response(null, {
        status: 304,
        headers: {
          ETag: upstream.headers.get('ETag') || etag || '',
          'Cache-Control':
            upstream.headers.get('Cache-Control') || contentCacheControl,
        },
      });
    if (upstream.status === 404)
      return unavailable('No completed transcript yet.', 404);
    if (upstream.status === 400)
      return unavailable('Try different search words.', 400);
    if (!upstream.ok) throw new Error('Transcript gateway failed');
    const headers = new Headers({
      'Content-Type':
        upstream.headers.get('Content-Type') ||
        'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...(upstream.headers.get('ETag')
        ? { ETag: upstream.headers.get('ETag')! }
        : {}),
    });
    return new Response(upstream.body, {
      headers: {
        ...Object.fromEntries(headers),
        'Cache-Control':
          params.get('fresh') === 'true'
            ? 'no-store'
            : path === '/v1/transcripts/search' || path.endsWith('/status')
              ? statusCacheControl
              : params.has('version')
                ? 'public, max-age=31536000, immutable'
                : contentCacheControl,
      },
    });
  } catch {
    return unavailable('Transcripts are temporarily unavailable.');
  }
}
