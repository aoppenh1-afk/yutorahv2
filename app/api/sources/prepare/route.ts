import { searchDatabase } from '../../../../lib/search-db';
import { transcriptGateway } from '../../../../lib/transcript-gateway';
import { sourcesResponse } from '../../../../lib/sources-handler';

/** Worker-authenticated warm-up uses the same published-transcript checks as the tab. */
export async function POST(request: Request) {
  const token = process.env.SOURCES_PREPARE_TOKEN;
  if (!token || request.headers.get('Authorization') !== `Bearer ${token}`)
    return Response.json(
      { error: 'Source preparation is unavailable.' },
      { status: token ? 403 : 503 },
    );
  try {
    const body = await request.json().catch(() => null);
    const shiurId = body?.shiurId;
    if (typeof shiurId !== 'string' || !/^[1-9]\d{0,11}$/.test(shiurId))
      return Response.json({ error: 'Choose a valid shiur.' }, { status: 400 });
    const url = new URL('/api/sources', request.url);
    url.searchParams.set('id', shiurId);
    return await sourcesResponse(new Request(url), {
      db: searchDatabase(),
      status: (id) =>
        transcriptGateway(
          `/v1/transcripts/${id}/status`,
          new URLSearchParams({ fresh: 'true' }),
        ),
      transcript: (id, version) =>
        transcriptGateway(
          `/v1/transcripts/${id}`,
          new URLSearchParams(version ? { version } : { fresh: 'true' }),
        ),
    });
  } catch {
    return Response.json(
      { error: 'Sources are temporarily unavailable.' },
      { status: 503, headers: { 'Retry-After': '2' } },
    );
  }
}
