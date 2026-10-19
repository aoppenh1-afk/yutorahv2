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

type Charts = Record<string, { ids: number[]; total: number }>;
const emptyCharts = (): Charts =>
  Object.fromEntries(
    variants.map((options) => [chartKey(options), { ids: [], total: 0 }]),
  );
const copyCharts = (charts: Charts): Charts =>
  Object.fromEntries(
    Object.entries(charts).map(([key, chart]) => [
      key,
      { ids: [...chart.ids], total: chart.total },
    ]),
  );
const countBits = (seen: Uint8Array) =>
  seen.reduce((sum, byte) => {
    let n = byte - ((byte >>> 1) & 0x55);
    n = (n & 0x33) + ((n >>> 2) & 0x33);
    return sum + ((n + (n >>> 4)) & 0x0f);
  }, 0);
const decodeSeen = (encoded: string, sampled: number) => {
  const seen = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (
    seen.length > Math.ceil(maxId / 8 / 1024) * 1024 ||
    seen[0] & 1 ||
    countBits(seen) !== sampled ||
    Buffer.from(seen).toString('base64') !== encoded
  )
    throw new TrendingChangedError(
      'The saved library coverage is invalid. Restarting indexing.',
    );
  return seen;
};
const rankCharts = (items: Shiur[], charts: Charts, at: number) => {
  const winners = new Map<number, Shiur>();
  for (const options of variants) {
    const ranked = rankTrending(items, 30, options, at);
    charts[chartKey(options)].ids = ranked.map((item) => item.id);
    for (const item of ranked) winners.set(item.id, item);
  }
  return [...winners.values()];
};

/** Offset traversal plus head reconciliation and an independent per-sweep census.
 * The census must observe every page, a stable total, and that many distinct IDs.
 * This is observed coverage, never an atomic snapshot guarantee. Legacy unions
 * remain resumable but must pass a new census before being called reconciled.
 */
export async function readTrendingIndex(
  _options: TrendingOptions,
  now: number,
  previous?: DiscoveryData,
): Promise<DiscoveryData> {
  const continuing = previous?.partial && previous.index?.version === 2;
  if (
    continuing &&
    previous.coverage?.retryAt &&
    previous.coverage.retryAt > now
  )
    return previous;
  const before = continuing ? previous.before : new Date(now).toISOString();
  const at = Date.parse(before);
  let seen: Uint8Array = continuing
    ? decodeSeen(previous.seen!, previous.sampled)
    : new Uint8Array();
  let sampled = continuing ? previous.sampled : 0;
  const startedSampled = sampled;
  let charts = continuing ? copyCharts(previous.index!.charts) : emptyCharts();
  let candidates = continuing ? [...previous.index!.items] : [];
  let nextPage = continuing ? previous.nextPage! : 1;
  let libraryTotal = continuing ? previous.libraryTotal! : 0;
  let round = continuing ? (previous.index!.round ?? 1) : 1;
  let roundStartedSampled = continuing
    ? (previous.index!.roundStartedSampled ?? sampled)
    : 0;
  let headPage = continuing ? (previous.index!.headPage ?? 1) : 1;
  const retries = new Map<number, { attempts: number; after: number }>(
    (continuing ? previous.index!.retryPages : []).map((page) => [
      page,
      { ...(previous!.index!.retries?.[page] ?? { attempts: 0, after: 0 }) },
    ]),
  );
  const savedAudit = continuing ? previous.index!.audit : undefined;
  let audit:
    | {
        seen: Uint8Array;
        sampled: number;
        total: number;
        stable: boolean;
        items: Shiur[];
        charts: Charts;
      }
    | undefined = savedAudit
    ? {
        ...savedAudit,
        seen: decodeSeen(savedAudit.seen, savedAudit.sampled),
        charts: copyCharts(savedAudit.charts),
        items: [...savedAudit.items],
      }
    : !continuing || nextPage === 1
      ? {
          seen: new Uint8Array(),
          sampled: 0,
          total: 0,
          stable: true,
          charts: emptyCharts(),
          items: [] as Shiur[],
        }
      : undefined;
  let requests = 0,
    successes = 0,
    observedTotal = 0;
  let lastError: unknown;
  const deadline = AbortSignal.timeout(45000);
  const budget = continuing ? pagesPerPass : initialPages;
  const results = new Map<number, Shiur[]>();
  const mark = (bitmap: Uint8Array, item: Shiur): [Uint8Array, boolean] => {
    const position = item.id >>> 3,
      mask = 1 << (item.id & 7);
    if (position >= bitmap.length) {
      const grown = new Uint8Array(Math.ceil((position + 1) / 1024) * 1024);
      grown.set(bitmap);
      bitmap = grown;
    }
    if (bitmap[position] & mask) return [bitmap, false];
    bitmap[position] |= mask;
    return [bitmap, true];
  };
  const add = (items: Shiur[]) => {
    for (const item of items) {
      let fresh: boolean;
      [seen, fresh] = mark(seen, item);
      if (fresh) {
        sampled++;
        candidates.push(item);
        for (const options of variants)
          if (inTrendingWindow(item, options, at))
            charts[chartKey(options)].total++;
      }
      if (audit) {
        [audit.seen, fresh] = mark(audit.seen, item);
        if (fresh) {
          audit.sampled++;
          audit.items.push(item);
          for (const options of variants)
            if (inTrendingWindow(item, options, at))
              audit.charts[chartKey(options)].total++;
        }
      }
    }
  };
  const read = async (page: number) => {
    if (deadline.aborted) {
      retries.set(page, {
        attempts: retries.get(page)?.attempts ?? 0,
        after: now + 30000,
      });
      return;
    }
    requests++;
    try {
      const { response: data } = await readTrendingPage(page, deadline);
      const offset = (page - 1) * 30;
      if (
        !data ||
        !Number.isSafeInteger(data.numFound) ||
        data.numFound < 0 ||
        !Array.isArray(data.docs) ||
        (data.start !== undefined && data.start !== page) ||
        data.docs.length !== Math.min(30, Math.max(0, data.numFound - offset))
      )
        throw new Error(
          'The mobile API returned an incomplete or misplaced library page.',
        );
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
      // Each response contributes to the sweep stability check. Do not replace
      // a moving denominator with historical union cardinality.
      if (audit) {
        if (!successes && !audit.sampled) audit.total = data.numFound;
        if (audit.total !== data.numFound) audit.stable = false;
      }
      observedTotal = Math.max(observedTotal, data.numFound);
      libraryTotal = observedTotal;
      successes++;
      retries.delete(page);
      results.set(page, items);
    } catch (error) {
      const attempts =
        (retries.get(page)?.attempts ?? 0) + (deadline.aborted ? 0 : 1);
      retries.set(page, {
        attempts,
        after:
          now + (attempts >= 3 ? 6 * 3600000 : 30000 * 2 ** (attempts - 1)),
      });
      lastError = error;
    }
  };
  if (!continuing) {
    await read(1);
    if (!successes) throw lastError;
    add(results.get(1)!);
    nextPage = 2;
  } else {
    // Follow the head until a fully known page anchors it. Persist this cursor
    // when an outage added more records than fit in a single bounded pass.
    for (let n = 0; n < 4 && requests < budget; n++) {
      const page = headPage;
      const retry = retries.get(page);
      if (retry && retry.after > now) break;
      await read(page);
      const items = results.get(page);
      if (!items) break;
      const known = items.every(
        (item) => !!(seen[item.id >>> 3] & (1 << (item.id & 7))),
      );
      add(items);
      if (known || items.length < 30) {
        headPage = 1;
        break;
      }
      headPage++;
    }
  }
  const pages: number[] = [];
  // At most one connection group handles due retries. An unavailable page
  // cannot starve forward traversal, nor get hammered on every request.
  for (const [page, retry] of [...retries].sort(([a], [b]) => a - b))
    if (retry.after <= now && !results.has(page) && pages.length < concurrency)
      pages.push(page);
  const end = Math.ceil(libraryTotal / 30);
  while (requests + pages.length < budget && nextPage <= end) {
    const page = nextPage++;
    if (!results.has(page) && !pages.includes(page) && !retries.has(page))
      pages.push(page);
  }
  // A slow page must not hold up five healthy connections at a batch barrier.
  let work = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
      while (work < pages.length) await read(pages[work++]);
    }),
  );
  // Apply results in page order, independent of network completion order.
  for (const page of pages) if (results.has(page)) add(results.get(page)!);
  candidates = rankCharts(candidates, charts, at);
  if (audit) audit.items = rankCharts(audit.items, audit.charts, at);
  let status: NonNullable<DiscoveryData['coverage']>['status'] = audit
    ? 'scanning'
    : 'reconciling';
  let retryAt: number | undefined;
  let reason: string | undefined;
  let partial = true;
  if (nextPage > Math.ceil(libraryTotal / 30)) {
    if (retries.size) {
      retryAt = Math.min(...[...retries.values()].map((retry) => retry.after));
      if (retryAt > now) status = 'paused';
      else retryAt = undefined;
      reason =
        'Library pages remain unavailable; saved progress will resume after backoff.';
    } else if (audit && audit.stable && audit.sampled === libraryTotal) {
      // Use this sweep's metadata and cohorts, excluding historical records
      // that disappeared. Union cardinality is never the completion test.
      partial = false;
      status = 'reconciled';
      sampled = audit.sampled;
      seen = audit.seen;
      charts = audit.charts;
      candidates = audit.items;
    } else {
      const gained = sampled - roundStartedSampled;
      round++;
      nextPage = 1;
      headPage = 1;
      roundStartedSampled = sampled;
      // Keep the union and its rankings while a fresh census checks gaps,
      // removals and offset shifts. Reset only the independent audit.
      audit = {
        seen: new Uint8Array(),
        sampled: 0,
        total: libraryTotal,
        stable: true,
        charts: emptyCharts(),
        items: [],
      };
      status = 'reconciling';
      // A whole sweep without new IDs is meaningful stalled evidence. A few
      // known pages are not: a missing recording may be at the archive tail.
      if (gained === 0 || round > 2) {
        status = 'paused';
        retryAt = now + 12 * 3600000;
        reason =
          'A full sweep could not reconcile coverage; upstream offsets or totals are inconsistent. A new census is scheduled.';
      }
    }
  }
  if (!successes && continuing) {
    status = 'paused';
    retryAt = Math.min(...[...retries.values()].map((retry) => retry.after));
    reason = 'YUTorah is unavailable; indexing progress is saved.';
  }
  return {
    trending: charts['all:0'].ids.map((id) =>
      candidates.find((item) => item.id === id)!,
    ),
    sampled,
    total: libraryTotal,
    libraryTotal,
    partial,
    source: 'mobile',
    nextPage,
    seen: partial ? Buffer.from(seen).toString('base64') : undefined,
    index: {
      version: 2,
      items: candidates,
      charts,
      retryPages: [...retries.keys()],
      retries: Object.fromEntries(retries),
      round,
      headPage,
      roundStartedSampled,
      audit:
        partial && audit
          ? { ...audit, seen: Buffer.from(audit.seen).toString('base64') }
          : undefined,
    },
    coverage: {
      status,
      guaranteed: false,
      observedTotal: libraryTotal,
      sweepSampled: partial ? (audit?.sampled ?? 0) : sampled,
      cursor: nextPage,
      round,
      pendingPages: retries.size,
      requests,
      added: Math.max(0, sampled - startedSampled),
      retryAt,
      reason,
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
    coverage: data.coverage,
    stale: data.stale,
    source: data.source,
    fetchedAt: data.fetchedAt,
    ...options,
    ...trendingWindow(options.period, Date.parse(data.before)),
    dateBasis: 'upload-date',
  };
}

/** Reject old or corrupt shared snapshots before the cache can serve them. */
export function validTrendingIndex(
  data: DiscoveryData,
  checkpoints = true,
): boolean {
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
        page >
          Math.max(1, data.nextPage ?? 1, Math.ceil(data.libraryTotal! / 30)),
    )
  )
    return false;
  const audit = index.audit;
  if (checkpoints && audit) {
    if (
      !Number.isSafeInteger(audit.sampled) ||
      audit.sampled < 0 ||
      !Number.isSafeInteger(audit.total) ||
      audit.total < 0 ||
      typeof audit.stable !== 'boolean' ||
      typeof audit.seen !== 'string' ||
      audit.seen.length > 700000 ||
      !Array.isArray(audit.items) ||
      !audit.charts
    )
      return false;
    try {
      decodeSeen(audit.seen, audit.sampled);
    } catch {
      return false;
    }
    // Reuse the same chart and metadata validation for the independent census.
    if (
      !validTrendingIndex({
        ...data,
        sampled: audit.sampled,
        seen: audit.seen,
        index: {
          version: 2,
          items: audit.items,
          charts: audit.charts,
          retryPages: [],
        },
        coverage: undefined,
      })
    )
      return false;
  }
  if (
    index.retries &&
    (typeof index.retries !== 'object' ||
      index.retryPages.some((page) => {
        const retry = index.retries![page];
        return (
          !retry ||
          !Number.isSafeInteger(retry.attempts) ||
          retry.attempts < 0 ||
          !Number.isFinite(retry.after) ||
          retry.after < 0
        );
      }))
  )
    return false;
  if (
    (index.round !== undefined &&
      (!Number.isSafeInteger(index.round) || index.round < 1)) ||
    (index.headPage !== undefined &&
      (!Number.isSafeInteger(index.headPage) || index.headPage < 1)) ||
    (data.partial &&
      index.roundStartedSampled !== undefined &&
      (!Number.isSafeInteger(index.roundStartedSampled) ||
        index.roundStartedSampled < 0 ||
        index.roundStartedSampled > data.sampled))
  )
    return false;
  if (
    data.coverage &&
    (data.coverage.guaranteed !== false ||
      data.coverage.observedTotal !== data.libraryTotal ||
      data.coverage.pendingPages !== index.retryPages.length ||
      !['scanning', 'reconciling', 'paused', 'reconciled'].includes(
        data.coverage.status,
      ) ||
      !Number.isSafeInteger(data.coverage.sweepSampled) ||
      data.coverage.sweepSampled < 0 ||
      (data.coverage.retryAt !== undefined &&
        !Number.isFinite(data.coverage.retryAt)) ||
      (!data.partial &&
        (data.coverage.status !== 'reconciled' ||
          index.retryPages.length > 0 ||
          data.sampled !== data.libraryTotal)))
  )
    return false;
  if (
    checkpoints &&
    data.partial &&
    (typeof data.seen !== 'string' || data.seen.length > 700000)
  )
    return false;
  const bitmap =
    checkpoints && data.partial ? Buffer.from(data.seen!, 'base64') : undefined;
  const ids = new Set(index.items.map((item) => item?.id));
  if (
    ids.size !== index.items.length ||
    index.items.some(
      (item) =>
        !item ||
        !Number.isSafeInteger(item.id) ||
        item.id <= 0 ||
        item.id >= maxId ||
        (bitmap && !(bitmap[item.id >>> 3] & (1 << (item.id & 7)))) ||
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
