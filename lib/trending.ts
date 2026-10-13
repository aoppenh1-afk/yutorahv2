import type { Shiur } from './yutorah';
import { mergeShiurim } from './learning';

export const trendingPeriods = [
  { value: 'day', label: '24 hours', days: 1 },
  { value: 'week', label: 'Week', days: 7 },
  { value: 'month', label: 'Month', days: 30 },
  { value: 'year', label: 'Year', days: 365 },
  { value: 'all', label: 'All time', days: 0 },
] as const;
export type TrendingPeriod = (typeof trendingPeriods)[number]['value'];
export type TrendingOptions = {
  period: TrendingPeriod;
  minutes: 0 | 10 | 20 | 30;
};
export class TrendingChangedError extends Error {}

export const defaultTrendingOptions: TrendingOptions = {
  period: 'week',
  minutes: 0,
};

export function parseTrendingOptions(params: URLSearchParams): TrendingOptions {
  const period = params.get('period') ?? defaultTrendingOptions.period;
  const minutes = params.get('minutes') ?? '0';
  if (
    !trendingPeriods.some((p) => p.value === period) ||
    !['0', '10', '20', '30'].includes(minutes)
  )
    throw new RangeError('Choose a valid trending period and length.');
  return {
    period: period as TrendingPeriod,
    minutes: Number(minutes) as TrendingOptions['minutes'],
  };
}

export function trendingWindow(period: TrendingPeriod, now: number) {
  const days = trendingPeriods.find((p) => p.value === period)!.days;
  return {
    after: days ? new Date(now - days * 86400000).toISOString() : null,
    before: new Date(now).toISOString(),
  };
}

export function inTrendingWindow(
  item: Shiur,
  options: TrendingOptions,
  now: number,
) {
  const after = trendingWindow(options.period, now).after;
  const submitted = Date.parse(item.uploadedAt || '');
  return (
    (!after ||
      (Number.isFinite(submitted) &&
        submitted >= Date.parse(after) &&
        submitted <= now)) &&
    (!options.minutes ||
      (item.duration > 0 && item.duration <= options.minutes * 60))
  );
}

/** Lifetime views within a dated cohort. No inferred rolling view counts. */
export function rankTrending(
  items: Shiur[],
  limit = 30,
  options?: TrendingOptions,
  now = Date.now(),
): Shiur[] {
  return mergeShiurim(items)
    .filter(
      (s) =>
        Number.isSafeInteger(s.id) &&
        s.id > 0 &&
        Number.isFinite(s.views) &&
        s.views! > 0 &&
        (!options || inTrendingWindow(s, options, now)),
    )
    .sort(
      (a, b) =>
        b.views! - a.views! ||
        (b.downloads || 0) - (a.downloads || 0) ||
        (Date.parse(b.uploadedAt || '') || 0) -
          (Date.parse(a.uploadedAt || '') || 0) ||
        b.id - a.id,
    )
    .slice(0, limit);
}

export type DiscoveryData = {
  trending: Shiur[];
  sampled: number;
  nextId?: number;
  source?: 'website' | 'mobile';
  libraryTotal?: number;
  nextPage?: number;
  /** Server-only coverage bitmap. Never serialized by the API route. */
  seen?: string;
  /** Server-only shared index, persisted with its coverage cursor. */
  index?: {
    version: 2;
    items: Shiur[];
    charts: Record<string, { ids: number[]; total: number }>;
    retryPages: number[];
    /** Independent census prevents a historical union from certifying coverage. */
    audit?: {
      seen: string;
      sampled: number;
      total: number;
      stable: boolean;
      items: Shiur[];
      charts: Record<string, { ids: number[]; total: number }>;
    };
    retries?: Record<string, { attempts: number; after: number }>;
    round?: number;
    headPage?: number;
    roundStartedSampled?: number;
  };
  coverage?: {
    status: 'scanning' | 'reconciling' | 'paused' | 'reconciled';
    /** The offset API has no snapshot or change feed. */
    guaranteed: false;
    observedTotal: number;
    sweepSampled: number;
    cursor: number;
    round: number;
    pendingPages: number;
    requests: number;
    added: number;
    retryAt?: number;
    reason?: string;
  };
  total: number;
  partial: boolean;
  /** A completed chart remains visible while its replacement is indexed. */
  refreshing?: boolean;
  fetchedAt: string;
  period: TrendingPeriod;
  minutes: TrendingOptions['minutes'];
  after: string | null;
  before: string;
  dateBasis: 'upload-date';
  stale: boolean;
};
