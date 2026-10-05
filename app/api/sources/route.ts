import { searchDatabase } from '../../../lib/search-db';
import { transcriptGateway } from '../../../lib/transcript-gateway';
import { sourcesResponse } from '../../../lib/sources-handler';

export async function GET(request: Request) {
  try {
    return await sourcesResponse(request, {
      db: searchDatabase(),
      status: (id) =>
        transcriptGateway(
          `/v1/transcripts/${id}/status`,
          new URLSearchParams(),
        ),
      transcript: (id, version) =>
        transcriptGateway(
          `/v1/transcripts/${id}`,
          new URLSearchParams(version ? { version } : {}),
        ),
    });
  } catch {
    return Response.json(
      { error: 'Sources storage is not configured yet.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
