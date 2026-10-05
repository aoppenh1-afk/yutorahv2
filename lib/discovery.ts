import { Buffer } from 'node:buffer';
import { mediaKind, normalize, upstream, ORIGIN } from './yutorah';
import { mergeShiurim } from './learning';
import type { RawShiur, SearchResponse } from './api-types';
import {
  defaultTrendingOptions,
  rankTrending,
  trendingWindow,
  inTrendingWindow,
  TrendingChangedError,
  type DiscoveryData,
  type TrendingOptions,
} from './trending';

export { rankTrending } from './trending';
export type { DiscoveryData } from './trending';

class TrendingSourceError extends Error {}

type MobileReader = (page: number) => Promise<SearchResponse>;
const mobilePage: MobileReader = (page) => {
  const query = new URLSearchParams({
    searchTerm: '',
    getFacets: 'false',
    start: String(page),
  });
  return upstream<SearchResponse>('search/get?' + query, 0);
};

/** Share short-lived source pages across all twenty chart variants. */
export function createDiscoveryReader(clock = Date.now) {
  const cached = new Map<number, { until: number; data: SearchResponse }>();
  const pending = new Map<number, Promise<SearchResponse>>();
  const read: MobileReader = async (page) => {
    const hit = cached.get(page);
    if (hit && hit.until > clock()) return hit.data;
    const active = pending.get(page);
    if (active) return active;
    const request = mobilePage(page);
    pending.set(page, request);
    try {
      const data = await request;
      if (cached.size >= 36 && !cached.has(page))
        cached.delete(cached.keys().next().value!);
      cached.set(page, { until: clock() + 60000, data });
      return data;
    } finally {
      pending.delete(page);
    }
  };
  return (
    options: TrendingOptions = defaultTrendingOptions,
    now = clock(),
    previous?: DiscoveryData,
  ) => getDiscovery(options, now, previous, read);
}

/** Prefer bounded source queries; a protected website cannot prevent discovery. */
export async function getDiscovery(
  options: TrendingOptions = defaultTrendingOptions,
  now = Date.now(),
  previous?: DiscoveryData,
  readMobile: MobileReader = mobilePage,
): Promise<DiscoveryData> {
  if (previous?.source === 'mobile')
    return getMobileDiscovery(options, now, previous, readMobile);
  try {
    return await getWebsiteDiscovery(options, now, previous);
  } catch (error) {
    if (!(error instanceof TrendingSourceError)) throw error;
    try {
      return await getMobileDiscovery(options, now, undefined, readMobile);
    } catch (fallback) {
      if (fallback instanceof TrendingChangedError) throw fallback;
      throw new Error(
        `${error.message} Mobile fallback: ${fallback instanceof Error ? fallback.message : 'unavailable'}`,
        { cause: fallback },
      );
    }
  }
}

/** One bounded, resumable page of the complete upload cohort. The public
 * endpoint supports ID ordering; its view-count sort is unreliable. Keyset
 * pagination keeps new uploads from shifting offsets during a long scan.
 */
async function getWebsiteDiscovery(
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
  if (window.after)
    filters.push(`shiurdatesubmitted:[${window.after} TO ${window.before}]`);
  if (options.minutes) filters.push(`duration:[1 TO ${options.minutes}]`);
  if (continuing) filters.push(`shiurid:[1 TO ${previous.nextId}]`);
  const query = new URLSearchParams({
    organizationID: '301',
    page: '1',
    search_query: '',
    sort_by: 'shiurid desc',
    facet_query: filters.join(','),
  });
  let response: Response;
  try {
    response = await fetch(`${ORIGIN}/Search/GetSearchResults?${query}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new TrendingSourceError(
      'The website search endpoint is unavailable.',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new TrendingSourceError(`YUTorah returned ${response.status}`);
  }
  let body: SearchResponse;
  try {
    body = (await response.json()) as SearchResponse;
  } catch {
    throw new TrendingSourceError('The website did not return JSON.');
  }
  const data = body.response;
  if (
    !data ||
    !Number.isSafeInteger(data.numFound) ||
    data.numFound < 0 ||
    !Array.isArray(data.docs) ||
    data.docs.length !== Math.min(data.numFound, 30)
  )
    throw new TrendingSourceError(
      'YUTorah returned an incomplete trending page.',
    );
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
        (window.after &&
          (!Number.isFinite(Date.parse(s.uploadedAt || '')) ||
            Date.parse(s.uploadedAt!) > at ||
            Date.parse(s.uploadedAt!) < Date.parse(window.after))) ||
        (options.minutes &&
          !(s.duration > 0 && s.duration <= options.minutes * 60)),
    )
  )
    throw new TrendingSourceError('YUTorah returned invalid trending data.');
  const total = continuing ? previous.total : data.numFound;
  const sampled = (continuing ? previous.sampled : 0) + items.length;
  if (sampled < total && items[items.length - 1].id <= 1)
    throw new TrendingSourceError(
      'YUTorah returned an inconsistent trending cursor.',
    );
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
    source: 'website',
    stale: false,
  };
}

/** The mobile API exposes counters but ignores upload filters and view sorting.
 * Scan its full library in bounded passes; a persisted bitmap audits unique IDs
 * through overlapping offset pages and repeats the scan when IDs are missing.
 */
async function getMobileDiscovery(
  options: TrendingOptions,
  now: number,
  previous: DiscoveryData | undefined,
  read: MobileReader,
): Promise<DiscoveryData> {
  const continuing =
    previous?.partial &&
    previous.source === 'mobile' &&
    previous.period === options.period &&
    previous.minutes === options.minutes;
  const window = continuing
    ? { after: previous.after, before: previous.before }
    : trendingWindow(options.period, now);
  const at = Date.parse(window.before);
  const first = continuing ? previous.nextPage! : 1;
  const count = continuing
    ? Math.min(
        first > 1 ? 3 : 4,
        Math.max(1, Math.ceil(previous.libraryTotal! / 30) - first + 1),
      )
    : 4;
  const sourcePages = Array.from({ length: count }, (_, i) => first + i);
  if (first > 1) sourcePages.push(1);
  const pages = await Promise.allSettled(sourcePages.map(read));
  let seen = continuing
    ? new Uint8Array(Buffer.from(previous.seen!, 'base64'))
    : new Uint8Array();
  let sampled = continuing ? previous.sampled : 0;
  let total = continuing ? previous.total : 0;
  let libraryTotal = 0;
  if (continuing) {
    const bits = seen.reduce((sum, byte) => {
      let n = byte & 0x55;
      n -= (n >>> 1) & 0x55;
      n = (n & 0x33) + ((n >>> 2) & 0x33);
      return sum + ((n + (n >>> 4)) & 0x0f);
    }, 0);
    if (
      bits !== sampled ||
      Buffer.from(seen).toString('base64') !== previous.seen
    )
      throw new TrendingChangedError(
        'The saved library coverage is invalid. Restarting indexing.',
      );
  }
  const candidates = continuing ? [...previous.trending] : [];
  for (const [i, page] of pages.entries()) {
    if (page.status === 'rejected') continue;
    const data = page.value.response;
    const offset = (sourcePages[i] - 1) * 30;
    if (
      !data ||
      !Number.isSafeInteger(data.numFound) ||
      data.numFound < 0 ||
      !Array.isArray(data.docs) ||
      data.docs.length !== Math.min(30, Math.max(0, data.numFound - offset))
    )
      throw new Error('The mobile API returned an incomplete library page.');
    libraryTotal = Math.max(libraryTotal, data.numFound);
    const items = data.docs.map(normalize);
    if (
      new Set(items.map((s) => s.id)).size !== items.length ||
      items.some(
        (s) =>
          !Number.isSafeInteger(s.id) ||
          s.id <= 0 ||
          s.id >= 4000000 ||
          !Number.isFinite(s.views) ||
          s.views! < 0,
      )
    )
      throw new Error('The mobile API returned invalid library data.');
    for (const item of items) {
      const position = item.id >>> 2;
      const shift = (item.id & 3) * 2;
      const mask = 1 << shift,
        matched = 2 << shift;
      if (position >= seen.length) {
        const grown = new Uint8Array(Math.ceil((position + 1) / 1024) * 1024);
        grown.set(seen);
        seen = grown;
      }
      const eligible = inTrendingWindow(item, options, at);
      const wasEligible = !!(seen[position] & matched);
      if (!(seen[position] & mask)) sampled++;
      if (wasEligible !== eligible) total += eligible ? 1 : -1;
      seen[position] =
        (seen[position] & ~matched) | mask | (eligible ? matched : 0);
      candidates.push(item);
    }
  }
  if (!libraryTotal && pages.some((page) => page.status === 'rejected')) {
    const failed = pages.find((page) => page.status === 'rejected');
    throw failed && failed.status === 'rejected'
      ? failed.reason
      : new Error('The mobile API is unavailable.');
  }
  if (sampled > libraryTotal)
    throw new TrendingChangedError(
      'The library changed during indexing. Restarting coverage.',
    );
  const partial = sampled < libraryTotal;
  const next = first + count;
  return {
    trending: rankTrending(candidates, 30, options, at),
    sampled,
    total,
    libraryTotal,
    partial,
    source: 'mobile',
    nextPage: partial
      ? next > Math.ceil(libraryTotal / 30)
        ? 1
        : next
      : undefined,
    seen: partial ? Buffer.from(seen).toString('base64') : undefined,
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
