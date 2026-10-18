import { onLCP, onINP, onCLS } from 'web-vitals';
import {
  clientMetrics,
  clientOperations,
  performanceEnabled,
  performanceReadyEvent,
} from './client-performance';
import {
  performanceMetrics,
  maxPerformanceBytes,
} from './performance-report-schema';
import { maxOperationSamples } from './performance-payload';

/** Successful sends consume samples and counters, so later beacons don't repeat them. */
export function reportClientPerformance(
  device: 'mobile' | 'desktop',
  send: (body: string) => boolean,
) {
  if (!performanceEnabled()) return false;
  const metrics = Object.fromEntries(
    performanceMetrics.flatMap((name) => {
      const value = clientMetrics[name];
      return Number.isFinite(value) && value >= 0 && value <= 1e8
        ? [[name, value]]
        : [];
    }),
  );
  if (!Object.keys(metrics).length && !clientOperations.length) return false;
  const count = clientOperations.length;
  const payload = JSON.stringify({
    device,
    metrics,
    operations: clientOperations,
  });
  if (new TextEncoder().encode(payload).byteLength > maxPerformanceBytes)
    return false;
  try {
    if (!send(payload)) return false;
  } catch {
    return false;
  }
  clientOperations.splice(0, count);
  for (const [name, value] of Object.entries(metrics))
    if (clientMetrics[name] === value) delete clientMetrics[name];
  return true;
}

/** Loaded only for sampled visits. Buffered observers include earlier events. */
export function observeClientPerformance(device: () => 'mobile' | 'desktop') {
  const metrics = clientMetrics;
  let stopped = false;
  const report = () =>
    reportClientPerformance(device(), (payload) =>
      navigator.sendBeacon(
        '/api/performance',
        new Blob([payload], { type: 'application/json' }),
      ),
    );
  const save = (metric: { name: string; value: number }) => {
    if (!stopped) metrics[metric.name] = metric.value;
  };
  onLCP(save);
  onINP(save);
  onCLS(save);
  const observer = new PerformanceObserver((list) => {
    metrics.longTasks = (metrics.longTasks ?? 0) + list.getEntries().length;
    metrics.longTaskMs =
      (metrics.longTaskMs ?? 0) +
      list.getEntries().reduce((total, entry) => total + entry.duration, 0);
  });
  if (PerformanceObserver.supportedEntryTypes.includes('longtask'))
    observer.observe({ type: 'longtask', buffered: true });
  const hidden = () => {
    if (document.hidden) report();
  };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', report);
  window.addEventListener(performanceReadyEvent, report);
  if (clientOperations.length === maxOperationSamples) report();
  return () => {
    stopped = true;
    observer.disconnect();
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', report);
    window.removeEventListener(performanceReadyEvent, report);
  };
}
