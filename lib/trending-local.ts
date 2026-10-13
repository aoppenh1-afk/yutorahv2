import {
  trendingPeriods,
  type DiscoveryData,
  type TrendingOptions,
} from './trending';

export const trendingLocalKey = 'yutorah-trending-charts-v1';
const chartKey = ({ period, minutes }: TrendingOptions) =>
  `${period}:${minutes}`;

/** A replacement census stays in the background until it can replace a saved chart. */
export function preferDiscoveryChart(
  previous: DiscoveryData | undefined,
  incoming: DiscoveryData,
): DiscoveryData {
  if (
    !previous ||
    previous.period !== incoming.period ||
    previous.minutes !== incoming.minutes
  )
    return incoming;
  if (
    incoming.partial &&
    (!previous.partial ||
      previous.before !== incoming.before ||
      (previous.trending.length > 0 && incoming.trending.length === 0))
  )
    return {
      ...previous,
      stale: true,
      refreshing: true,
      coverage: incoming.coverage,
    };
  if (
    previous.partial === incoming.partial &&
    Date.parse(previous.fetchedAt) > Date.parse(incoming.fetchedAt)
  )
    return previous;
  return incoming;
}

function validChart(value: unknown): value is DiscoveryData {
  if (!value || typeof value !== 'object') return false;
  const data = value as DiscoveryData;
  return (
    trendingPeriods.some(({ value }) => value === data.period) &&
    [0, 10, 20, 30].includes(data.minutes) &&
    data.dateBasis === 'upload-date' &&
    typeof data.partial === 'boolean' &&
    typeof data.stale === 'boolean' &&
    Number.isFinite(Date.parse(data.fetchedAt)) &&
    Number.isFinite(Date.parse(data.before)) &&
    Number.isSafeInteger(data.sampled) &&
    data.sampled >= 0 &&
    Number.isSafeInteger(data.total) &&
    data.total >= 0 &&
    Array.isArray(data.trending) &&
    data.trending.length <= 30 &&
    data.trending.length <= data.sampled &&
    data.trending.length <= data.total &&
    new Set(data.trending.map((item) => item?.id)).size ===
      data.trending.length &&
    data.trending.every(
      (item) =>
        item &&
        Number.isSafeInteger(item.id) &&
        item.id > 0 &&
        Number.isFinite(item.views) &&
        item.views! > 0 &&
        typeof item.title === 'string' &&
        typeof item.teacher === 'string' &&
        Number.isFinite(item.duration) &&
        item.duration >= 0 &&
        Array.isArray(item.topics) &&
        item.topics.every((topic) => typeof topic === 'string'),
    )
  );
}

/** Small public chart snapshots only. Storage failures still leave a memory cache. */
export function createTrendingLocalCache(
  storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined,
) {
  const charts: Record<string, DiscoveryData> = {};
  let loaded = false;
  const read = () => {
    if (!loaded) {
      loaded = true;
      try {
        const encoded = storage()?.getItem(trendingLocalKey);
        if (encoded && encoded.length <= 2_000_000) {
          const saved: unknown = JSON.parse(encoded);
          if (saved && typeof saved === 'object' && !Array.isArray(saved))
            for (const [key, data] of Object.entries(saved))
              if (validChart(data) && key === chartKey(data))
                charts[key] = data;
        }
      } catch {
        /* Private browsing, corrupt storage and quota failures do not hide charts. */
      }
    }
    // A local snapshot is displayed with its real timestamp and checked in the background.
    return Object.fromEntries(
      Object.entries(charts).map(([key, data]) => [
        key,
        { ...data, stale: true },
      ]),
    );
  };
  const save = (data: DiscoveryData) => {
    read();
    if (!validChart(data)) return data;
    const key = chartKey(data);
    const selected = preferDiscoveryChart(charts[key], data);
    const {
      index: _index,
      seen: _seen,
      nextPage: _page,
      nextId: _id,
      ...publicData
    } = selected;
    charts[key] = publicData;
    try {
      const encoded = JSON.stringify(charts);
      if (encoded.length <= 2_000_000)
        storage()?.setItem(trendingLocalKey, encoded);
    } catch {
      /* Keep displaying the in-memory chart when storage is unavailable. */
    }
    return publicData;
  };
  return { read, save };
}

const browserCharts = createTrendingLocalCache(() => window.localStorage);
export const readLocalDiscoveryCharts = (): Record<string, DiscoveryData> =>
  typeof window === 'undefined' ? {} : browserCharts.read();
export const rememberDiscoveryChart = (data: DiscoveryData): DiscoveryData =>
  typeof window === 'undefined' ? data : browserCharts.save(data);
