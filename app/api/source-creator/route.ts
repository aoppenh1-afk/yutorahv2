import { upstream } from '../../../lib/yutorah';
import { sourceDescription } from '../../../lib/source-description';
import type { RawShiur } from '../../../lib/api-types';
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
      description: async (id) => {
        const raw = await upstream<RawShiur>(
          'shiur/details?shiurID=' + id,
          600,
        );
        if (!raw?.shiurID && !raw?.shiurid)
          return Response.json({}, { status: 404 });
        return Response.json(sourceDescription(raw, id));
      },
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
