import { mediaKind, normalize, upstream, type Shiur } from './yutorah';
import { mergeShiurim } from './learning';
import type { RawShiur, SearchResponse } from './api-types';

export type DiscoveryData = {
  trending: Shiur[];
  sampled: number;
  partial: boolean;
  fetchedAt: string;
};

/** Public view counts are lifetime totals, not a rolling popularity chart. */
export function rankTrending(items: Shiur[], limit = 12): Shiur[] {
  return mergeShiurim(items)
    .filter((s) => s.views !== undefined && s.views > 0)
    .sort(
      (a, b) =>
        (b.views || 0) - (a.views || 0) ||
        (b.downloads || 0) - (a.downloads || 0) ||
        (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0),
    )
    .slice(0, limit);
}

export async function getDiscovery(): Promise<DiscoveryData> {
  // The public unfiltered index returns recordings in date order, 30 per page.
  const pages = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => {
      const query = new URLSearchParams({
        searchTerm: '',
        getFacets: 'false',
        start: String(i + 1),
      });
      return upstream<SearchResponse>('search/get?' + query, 300);
    }),
  );
  const items = mergeShiurim(
    pages.flatMap((page) =>
      page.status === 'fulfilled' && Array.isArray(page.value.response?.docs)
        ? page.value.response.docs.map(normalize)
        : [],
    ),
  );
  if (!items.length) throw new Error('Discovery is temporarily unavailable.');
  return {
    // Keep the sample so a duration filter can rank its own chart, rather than
    // filtering only the first twelve recordings in the unfiltered chart.
    trending: rankTrending(items, 180),
    sampled: items.length,
    partial: pages.some(
      (page) =>
        page.status === 'rejected' || !Array.isArray(page.value.response?.docs),
    ),
    fetchedAt: new Date().toISOString(),
  };
}

export async function getRelatedCandidates(id: number) {
  const raw = await upstream<RawShiur>('shiur/details?shiurID=' + id, 600);
  if (!raw?.shiurID) throw new Error('Shiur not found.');
  const source = normalize(raw);
  const sources: { field: string; id: number }[] = [];
  if (source.seriesId > 0)
    sources.push({ field: 'seriesID', id: source.seriesId });
  for (const topic of (source.topicIds || []).slice(0, 2))
    sources.push({ field: 'subcategoryID', id: topic });
  if (source.teacherId > 0)
    sources.push({ field: 'teacherID', id: source.teacherId });
  const pages = await Promise.allSettled(
    sources.map(({ field, id: sourceId }) => {
      const query = new URLSearchParams({
        searchTerm: '',
        getFacets: 'false',
        start: '1',
        [field]: String(sourceId),
      });
      return upstream<SearchResponse>('search/get?' + query, 300);
    }),
  );
  const items = mergeShiurim(
    pages.flatMap((page) =>
      page.status === 'fulfilled' && Array.isArray(page.value.response?.docs)
        ? page.value.response.docs.map(normalize)
        : [],
    ),
  ).filter(
    (s) =>
      s.id !== id &&
      (mediaKind(source) !== 'audio' || mediaKind(s) === 'audio'),
  );
  return {
    source,
    items,
    partial: pages.some(
      (page) =>
        page.status === 'rejected' || !Array.isArray(page.value.response?.docs),
    ),
  };
}
