import { mediaKind, normalize, upstream, ORIGIN } from './yutorah';
import { mergeShiurim } from './learning';
import type { RawShiur, SearchResponse } from './api-types';
import {
  defaultTrendingOptions,
  rankTrending,
  trendingWindow,
  TrendingChangedError,
  type DiscoveryData,
  type TrendingOptions,
} from './trending';

export { rankTrending } from './trending';
export type { DiscoveryData } from './trending';

/** One bounded, resumable page of the complete upload cohort. The public
 * endpoint supports ID ordering; its view-count sort is unreliable. Keyset
 * pagination keeps new uploads from shifting offsets during a long scan.
 */
export async function getDiscovery(
  options: TrendingOptions = defaultTrendingOptions,
  now = Date.now(),
  previous?: DiscoveryData,
): Promise<DiscoveryData> {
  const continuing =
    previous?.partial &&
    previous.period === options.period &&
    previous.minutes === options.minutes;
  const window = continuing
    ? { after: previous.after, before: previous.before }
    : trendingWindow(options.period, now);
  const filters = ['teacherishidden:0'];
  filters.push(
    `shiurdatesubmitted:[${window.after || '*'} TO ${window.before}]`,
  );
  if (options.minutes) filters.push(`duration:[1 TO ${options.minutes}]`);
  if (continuing) filters.push(`shiurid:[1 TO ${previous.nextId}]`);
  const query = new URLSearchParams({
    organizationID: '301',
    page: '1',
    search_query: '',
    sort_by: 'shiurid desc',
    facet_query: filters.join(','),
  });
  const response = await fetch(`${ORIGIN}/Search/GetSearchResults?${query}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) throw new Error(`YUTorah returned ${response.status}`);
  const body = (await response.json()) as SearchResponse;
  const data = body.response;
  if (
    !data ||
    !Number.isSafeInteger(data.numFound) ||
    data.numFound < 0 ||
    !Array.isArray(data.docs) ||
    data.docs.length !== Math.min(data.numFound, 30)
  )
    throw new Error('YUTorah returned an incomplete trending page.');
  if (continuing && data.numFound !== previous.total - previous.sampled)
    throw new TrendingChangedError(
      'The upload cohort changed during indexing. Please retry.',
    );
  const items = data.docs.map(normalize);
  const at = Date.parse(window.before);
  if (
    items.some(
      (s, i) =>
        !Number.isSafeInteger(s.id) ||
        s.id <= 0 ||
        !Number.isFinite(s.views) ||
        s.views! < 0 ||
        (i > 0 && s.id >= items[i - 1].id) ||
        (continuing && s.id > previous.nextId!) ||
        !Number.isFinite(Date.parse(s.uploadedAt || '')) ||
        Date.parse(s.uploadedAt!) > at ||
        (window.after &&
          Date.parse(s.uploadedAt!) < Date.parse(window.after)) ||
        (options.minutes &&
          !(s.duration > 0 && s.duration <= options.minutes * 60)),
    )
  )
    throw new Error('YUTorah returned invalid trending data.');
  const total = continuing ? previous.total : data.numFound;
  const sampled = (continuing ? previous.sampled : 0) + items.length;
  if (sampled < total && items[items.length - 1].id <= 1)
    throw new Error('YUTorah returned an inconsistent trending cursor.');
  return {
    trending: rankTrending(
      [...(continuing ? previous.trending : []), ...items],
      30,
      options,
      at,
    ),
    sampled,
    total,
    partial: sampled < total,
    nextId: items.length ? items[items.length - 1].id - 1 : 0,
    fetchedAt: new Date(now).toISOString(),
    ...options,
    ...window,
    dateBasis: 'upload-date',
    stale: false,
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
