import type { SearchDatabase } from './search-storage';
import { sourceFeatures, type SourceFeatures } from './source-features';
import { verifyManualSource } from './source-manual';
import {
  cachedSourceText,
  readCachedSourceText,
  pruneSourceCache,
} from './sources-cache';
import type { SefariaFetch } from './sefaria';

export async function sourceTextResponse(
  request: Request,
  dependencies: {
    database: () => SearchDatabase;
    fetcher?: SefariaFetch;
    features?: SourceFeatures;
  },
) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!(dependencies.features || sourceFeatures()).sheets)
    return Response.json(
      { error: 'Source sheets are turned off.' },
      { status: 404, headers },
    );
  const params = new URL(request.url).searchParams;
  const ref = params.get('ref') || '';
  if (!ref || ref.length > 250)
    return Response.json(
      { error: 'Choose a valid reference.' },
      { status: 400, headers },
    );
  try {
    const db = dependencies.database();
    await pruneSourceCache(db);
    const extent = params.get('extent') === 'full' ? 'full' : 'excerpt';
    const cached = await readCachedSourceText(db, ref, extent);
    if (cached)
      return Response.json(cached, {
        headers: { 'Cache-Control': 'public, max-age=3600' },
      });
    const source = await verifyManualSource(ref, dependencies.fetcher);
    if (!source || source.ref !== ref)
      return Response.json(
        { error: 'Choose a canonical source reference.' },
        { status: 422, headers },
      );
    const text = await cachedSourceText(db, ref, dependencies.fetcher, extent);
    return Response.json(text, {
      headers: { 'Cache-Control': 'public, max-age=3600' },
    });
  } catch {
    return Response.json(
      { error: 'This source text is unavailable. Retry to load it.' },
      { status: 503, headers: { ...headers, 'Retry-After': '2' } },
    );
  }
}
