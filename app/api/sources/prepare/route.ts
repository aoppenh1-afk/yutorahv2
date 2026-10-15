import { searchDatabase } from '../../../../lib/search-db';
import { websiteTranscript } from '../../../../lib/website-transcript';
import { hostedNotes } from '../../../../lib/tidb-notes';
import { sourceCreatorResponse } from '../../../../lib/source-creator-handler';

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
    if (typeof body.transcriptId === 'string')
      url.searchParams.set('revision', body.transcriptId);
    if (typeof body.version === 'string')
      url.searchParams.set('version', body.version);
    return await sourceCreatorResponse(new Request(url), {
      db: searchDatabase(),
      transcript: websiteTranscript,
      notes: hostedNotes,
    });
  } catch {
    return Response.json(
      { error: 'Sources are temporarily unavailable.' },
      { status: 503, headers: { 'Retry-After': '2' } },
    );
  }
}
