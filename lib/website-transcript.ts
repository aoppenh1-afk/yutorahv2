import { officialTranscript } from './official-transcript';
import { transcriptGateway } from './transcript-gateway';

/** Current reading prefers YUTorah; archived versions retain their original source. */
export async function websiteTranscript(
  id: string,
  params: URLSearchParams,
  etag?: string,
): Promise<Response> {
  const source = params.get('source');
  if (source && source !== 'official-yutorah')
    return Response.json(
      { error: 'Invalid transcript source.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  if (!source && params.has('version'))
    return transcriptGateway(`/v1/transcripts/${id}`, params, etag);
  const official = await officialTranscript(id, params, etag);
  if (source || official.ok || official.status === 304) return official;
  const hasLocal = Boolean(
    process.env.TRANSCRIPT_ARCHIVE_URL ||
    process.env.TRANSCRIPT_DATABASE_URL ||
    process.env.TRANSCRIPT_API_URL,
  );
  if (!hasLocal) return official;
  const local = await transcriptGateway(`/v1/transcripts/${id}`, params, etag);
  if (local.ok || local.status === 304) return local;
  return official.status === 503 && local.status === 404 ? official : local;
}
