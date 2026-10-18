import {
  maxOperationSamples,
  maxOperationMs,
  type DataArea,
  type DataSource,
  type DataOperation,
} from './performance-payload';
export type { DataSource } from './performance-payload';
let sampled: boolean | undefined;
export const clientMetrics: Record<string, number> = {};
export const clientOperations: DataOperation[] = [];
export const performanceReadyEvent = 'yutorah-performance-ready';
export function performanceEnabled() {
  if (typeof window === 'undefined') return false;
  if (sampled === undefined) {
    sampled = Math.random() < 0.01;
    try {
      sampled ||= sessionStorage.getItem('yutorah-performance-sample') === '1';
    } catch {
      /* Optional diagnostics. */
    }
  }
  return sampled;
}
export function performanceCount(name: string, value: number) {
  if (performanceEnabled())
    clientMetrics[name] = (clientMetrics[name] ?? 0) + value;
}
export function recordDataOperation(operation: DataOperation) {
  if (
    !performanceEnabled() ||
    !Number.isFinite(operation.ms) ||
    operation.ms < 0 ||
    operation.ms > maxOperationMs
  )
    return;
  if (clientOperations.length === maxOperationSamples) {
    performanceCount('operationSamplesDropped', 1);
    return;
  }
  clientOperations.push({ ...operation, ms: Math.round(operation.ms) });
  if (clientOperations.length === maxOperationSamples)
    queueMicrotask(() =>
      window.dispatchEvent(new Event(performanceReadyEvent)),
    );
}

/** A one-use marker invoked by the data view's layout effect after DOM commit. */
export function dataCommitTiming(
  area: DataArea,
  started: number,
  source: DataSource,
  phase: DataOperation['phase'] = 'first',
  signal?: AbortSignal,
) {
  if (!performanceEnabled()) return undefined;
  let recorded = false;
  return () => {
    if (recorded || signal?.aborted) return;
    recorded = true;
    recordDataOperation({
      area,
      phase,
      ms: performance.now() - started,
      source,
    });
  };
}
export type DataCommitTiming = ReturnType<typeof dataCommitTiming>;

/** Sources describe this operation, independently of the HTML navigation cache. */
export function responseDataSource(
  response: Response,
  started: number,
): DataSource {
  if (!performanceEnabled()) return 'unknown';
  const entries = response.url
    ? (performance.getEntriesByName(
        response.url,
        'resource',
      ) as PerformanceResourceTiming[])
    : [];
  const entry = entries.findLast(
    (e) => e.initiatorType === 'fetch' && e.startTime >= started,
  );
  if (
    entry &&
    ((entry as PerformanceResourceTiming & { deliveryType?: string })
      .deliveryType === 'cache' ||
      entry.responseStatus === 304 ||
      (entry.transferSize === 0 && entry.encodedBodySize > 0))
  )
    return 'http-cache';
  if (
    ['HIT', 'STALE', 'REVALIDATED', 'UPDATING'].includes(
      response.headers.get('CF-Cache-Status') || '',
    ) ||
    ['HIT', 'STALE'].includes(response.headers.get('X-Vercel-Cache') || '') ||
    Number(response.headers.get('Age')) > 0
  )
    return 'edge-cache';
  const source = response.headers.get('X-Yutorah-Cache');
  return source === 'server-memory' ||
    source === 'snapshot' ||
    source === 'refresh'
    ? source
    : 'network';
}
