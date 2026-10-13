import { normalize, upstream } from '@/lib/yutorah';
import type { SearchResponse } from '@/lib/api-types';
import { followKinds, mergeShiurim } from '@/lib/learning';

/** A bounded discovery sample, independent of the exhaustive search index. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const sources: { kind: string; id: number }[] = [];
  for (const kind of followKinds) {
    const raw = params.get(kind) || '';
    if (raw.length > 250)
      return Response.json(
        { error: 'Too many follows requested.' },
        { status: 400 },
      );
    for (const token of raw.split(',').filter(Boolean)) {
      if (!/^\d{1,8}$/.test(token) || Number(token) <= 0)
        return Response.json(
          { error: 'Choose a valid library follow.' },
          { status: 400 },
        );
      if (!sources.some((s) => s.kind === kind && s.id === Number(token)))
        sources.push({ kind, id: Number(token) });
    }
  }
  if (sources.length > 8)
    return Response.json(
      { error: 'Choose up to eight feed sources at a time.' },
      { status: 400 },
    );
  const pages = await Promise.allSettled(
    sources.map(async ({ kind, id }) => {
      const p = new URLSearchParams({
        searchTerm: '*',
        getFacets: 'false',
        start: '1',
        [kind === 'topic'
          ? 'subcategoryID'
          : kind === 'venue'
            ? 'locationID'
            : kind + 'ID']: String(id),
      });
      const data = await upstream<SearchResponse>('search/get?' + p, 180);
      if (!Array.isArray(data.response?.docs))
        throw new Error('Feed unavailable');
      return data.response.docs.map((raw) => {
        const s = normalize(raw);
        // Scoped searches establish membership even when a legacy record omits it.
        if (kind === 'venue') s.venueId = id;
        if (kind === 'collection' && !s.collections?.some((c) => c.id === id))
          s.collections = [...(s.collections || []), { id, name: '' }];
        return s;
      });
    }),
  );
  const items = mergeShiurim(
    pages.flatMap((page) => (page.status === 'fulfilled' ? page.value : [])),
  );
  return Response.json(
    {
      items,
      partial: pages.some((p) => p.status === 'rejected'),
      sources: sources.length,
    },
    { headers: { 'Cache-Control': 'private, max-age=120' } },
  );
}
