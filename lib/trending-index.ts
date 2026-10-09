import { Buffer } from 'node:buffer';
import { normalize, type Shiur } from './yutorah';
import { readTrendingPage } from './trending-source';
import {
  inTrendingWindow,
  rankTrending,
  trendingPeriods,
  trendingWindow,
  TrendingChangedError,
  type DiscoveryData,
  type TrendingOptions,
} from './trending';

const variants = trendingPeriods.flatMap(({ value: period }) =>
  ([0, 10, 20, 30] as const).map((minutes) => ({ period, minutes })),
);
const chartKey = ({ period, minutes }: TrendingOptions) =>
  `${period}:${minutes}`;
const initialPages = 12;
const pagesPerPass = 36;
const concurrency = 6;
const maxId = 4_000_000;

/** One durable library traversal builds all twenty charts. Each record is
 * assigned to the frozen upload cohorts exactly once, despite offset overlap.
 * Failed pages are retried on the next pass, ahead of further enumeration.
 */
export async function readTrendingIndex(
  _options: TrendingOptions,
  now: number,
  previous?: DiscoveryData,
): Promise<DiscoveryData> {
  const continuing = previous?.partial && previous.index?.version === 2;
  const before = continuing ? previous.before : new Date(now).toISOString();
  const at = Date.parse(before);
  let seen: Uint8Array = continuing
    ? new Uint8Array(Buffer.from(previous.seen!, 'base64'))
    : new Uint8Array();
  let sampled = continuing ? previous.sampled : 0;
  if (continuing) {
    const counted = seen.reduce((sum, byte) => {
      let n = byte - ((byte >>> 1) & 0x55);
      n = (n & 0x33) + ((n >>> 2) & 0x33);
      return sum + ((n + (n >>> 4)) & 0x0f);
    }, 0);
    if (
      counted !== sampled ||
      Buffer.from(seen).toString('base64') !== previous.seen
    )
      throw new TrendingChangedError(
        'The saved library coverage is invalid. Restarting indexing.',
      );
  }
  const charts = Object.fromEntries(
    variants.map((options) => {
      const key = chartKey(options);
      return [
        key,
        {
          ids: [...(continuing ? previous.index!.charts[key].ids : [])],
          total: continuing ? previous.index!.charts[key].total : 0,
        },
      ];
    }),
  );
  const candidates: Shiur[] = continuing ? [...previous.index!.items] : [];
  const retries = new Set(continuing ? previous.index!.retryPages : []);
  let nextPage = continuing ? previous.nextPage! : 1;
  let libraryTotal = continuing ? previous.libraryTotal! : 0;
  let observedTotal = 0;
  let successes = 0;
  let lastError: unknown;

  const read = async (page: number) => {
    try {
      const { response: data } = await readTrendingPage(page);
      const offset = (page - 1) * 30;
      if (
        !data ||
        !Number.isSafeInteger(data.numFound) ||
        data.numFound < 0 ||
        !Array.isArray(data.docs) ||
        data.docs.length !== Math.min(30, Math.max(0, data.numFound - offset))
      )
        throw new Error('The mobile API returned an incomplete library page.');
      const items = data.docs.map(normalize);
      if (
        new Set(items.map((item) => item.id)).size !== items.length ||
        items.some(
          (item) =>
            !Number.isSafeInteger(item.id) ||
            item.id <= 0 ||
            item.id >= maxId ||
            !Number.isFinite(item.views) ||
            item.views! < 0,
        )
      )
        throw new Error('The mobile API returned invalid library data.');
      observedTotal = Math.max(observedTotal, data.numFound);
      libraryTotal = observedTotal;
      successes++;
      retries.delete(page);
      for (const item of items) {
        const position = item.id >>> 3,
          mask = 1 << (item.id & 7);
        if (position >= seen.length) {
          const grown = new Uint8Array(Math.ceil((position + 1) / 1024) * 1024);
          grown.set(seen);
          seen = grown;
        }
        if (seen[position] & mask) continue;
        seen[position] |= mask;
        sampled++;
        candidates.push(item);
        for (const options of variants)
          if (inTrendingWindow(item, options, at))
            charts[chartKey(options)].total++;
      }
    } catch (error) {
      retries.add(page);
      lastError = error;
    }
  };

  let budget = continuing ? pagesPerPass : initialPages;
  if (!continuing) {
    await read(1);
    if (!successes) throw lastError;
    nextPage = 2;
    budget--;
  }
  const pages = [...retries].sort((a, b) => a - b).slice(0, budget);
  const end = Math.ceil(libraryTotal / 30);
  while (pages.length < budget && nextPage <= end) {
    const page = nextPage++;
    if (!pages.includes(page)) pages.push(page);
  }
  // Bound active upstream connections, even when several users open charts.
  for (let offset = 0; offset < pages.length; offset += concurrency)
    await Promise.all(pages.slice(offset, offset + concurrency).map(read));
  if (!successes)
    throw lastError ?? new Error('The mobile API is unavailable.');
  if (sampled > libraryTotal)
    throw new TrendingChangedError(
      'The library changed during indexing. Restarting coverage.',
    );
  const winners = new Map<number, Shiur>();
  for (const options of variants) {
    const ranked = rankTrending(candidates, 30, options, at);
    charts[chartKey(options)].ids = ranked.map((item) => item.id);
    for (const item of ranked) winners.set(item.id, item);
  }
  const partial = sampled < libraryTotal;
  return {
    trending: charts['all:0'].ids.map((id) => winners.get(id)!),
    sampled,
    total: libraryTotal,
    libraryTotal,
    partial,
    source: 'mobile',
    nextPage: nextPage > Math.ceil(libraryTotal / 30) ? 1 : nextPage,
    seen: partial ? Buffer.from(seen).toString('base64') : undefined,
    index: {
      version: 2,
      items: [...winners.values()],
      charts,
      retryPages: [...retries],
    },
    fetchedAt: new Date(now).toISOString(),
    before,
    after: null,
    period: 'all',
    minutes: 0,
    dateBasis: 'upload-date',
    stale: false,
  };
}

/** Keep the shared index and cursor private, returning only this chart. */
export function selectTrendingChart(
  data: DiscoveryData,
  options: TrendingOptions,
): DiscoveryData {
  const chart = data.index!.charts[chartKey(options)];
  const items = new Map(data.index!.items.map((item) => [item.id, item]));
  return {
    trending: chart.ids.map((id) => items.get(id)!),
    total: chart.total,
    sampled: data.sampled,
    libraryTotal: data.libraryTotal,
    partial: data.partial,
    refreshing: data.refreshing,
    stale: data.stale,
    source: data.source,
    fetchedAt: data.fetchedAt,
    ...options,
    ...trendingWindow(options.period, Date.parse(data.before)),
    dateBasis: 'upload-date',
  };
}

/** Reject old or corrupt shared snapshots before the cache can serve them. */
export function validTrendingIndex(data: DiscoveryData): boolean {
  const index = data.index;
  if (
    !index ||
    index.version !== 2 ||
    !Array.isArray(index.items) ||
    index.items.length > 600 ||
    !index.charts ||
    !Array.isArray(index.retryPages) ||
    !Number.isFinite(Date.parse(data.before)) ||
    !Number.isSafeInteger(data.libraryTotal) ||
    data.libraryTotal! < 0 ||
    index.retryPages.some(
      (page) =>
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > Math.max(1, Math.ceil(data.libraryTotal! / 30)),
    )
  )
    return false;
  const ids = new Set(index.items.map((item) => item?.id));
  if (
    ids.size !== index.items.length ||
    index.items.some(
      (item) =>
        !item ||
        !Number.isSafeInteger(item.id) ||
        item.id <= 0 ||
        item.id >= maxId ||
        !Number.isFinite(item.views) ||
        item.views! <= 0,
    )
  )
    return false;
  return (
    variants.every((options) => {
      const chart = index.charts[chartKey(options)];
      return (
        chart &&
        Number.isSafeInteger(chart.total) &&
        chart.total >= 0 &&
        chart.total <= data.sampled &&
        Array.isArray(chart.ids) &&
        chart.ids.length <= 30 &&
        chart.ids.length <= chart.total &&
        new Set(chart.ids).size === chart.ids.length &&
        chart.ids.every((id) => ids.has(id))
      );
    }) && index.charts['all:0'].total === data.sampled
  );
}
