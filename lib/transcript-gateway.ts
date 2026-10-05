/** Only the website server knows the VM's read token. */
import {
  contentCacheControl,
  statusCacheControl,
} from '../packages/transcription/src/public-content';
export async function transcriptGateway(
  path: string,
  params: URLSearchParams,
): Promise<Response> {
  const archive = process.env.TRANSCRIPT_ARCHIVE_URL;
  if (!archive && process.env.TRANSCRIPT_DATABASE_URL) {
    const { transcriptDatabaseGateway } = await import('./transcript-database');
    return transcriptDatabaseGateway(path, params);
  }
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
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
      cache: params.get('fresh') === 'true' ? 'no-store' : 'default',
    });
    if (upstream.status === 404)
      return unavailable('No completed transcript yet.', 404);
    if (upstream.status === 400)
      return unavailable('Try different search words.', 400);
    if (!upstream.ok) throw new Error('Transcript gateway failed');
    return Response.json(await upstream.json(), {
      headers: {
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
