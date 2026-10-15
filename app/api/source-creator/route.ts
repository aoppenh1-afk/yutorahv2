import { searchDatabase } from '../../../lib/search-db';
import { websiteTranscript } from '../../../lib/website-transcript';
import { hostedNotes } from '../../../lib/tidb-notes';
import { sourceCreatorResponse } from '../../../lib/source-creator-handler';
import { sourceFeatures } from '../../../lib/source-features';

export async function GET(request: Request) {
  const features = sourceFeatures();
  if (!features.links && !features.sheets)
    return Response.json(
      { error: 'Source creation is turned off.' },
      { status: 404 },
    );
  try {
    return await sourceCreatorResponse(request, {
      db: searchDatabase(),
      transcript: websiteTranscript,
      notes: hostedNotes,
      features,
    });
  } catch {
    return Response.json(
      { error: 'Source storage is unavailable. Retry in a moment.' },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
      },
    );
  }
}
