'use client';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  clientMetrics,
  performanceEnabled,
  performanceCount,
} from '@/lib/client-performance';

/** Sample the application render through its committed DOM, including large views. */
export function useViewPerformance() {
  const started = performanceEnabled() ? performance.now() : undefined;
  useLayoutEffect(() => {
    if (started === undefined) return;
    if (performance.getEntriesByName('yutorah-view-commit').length >= 100)
      performance.clearMeasures('yutorah-view-commit');
    performance.measure('yutorah-view-commit', {
      start: started,
      end: performance.now(),
    });
    performanceCount('viewCommits', 1);
    performanceCount('viewCommitMs', performance.now() - started);
    clientMetrics.maxVisibleRows = Math.max(
      clientMetrics.maxVisibleRows ?? 0,
      document.querySelectorAll('.shiur-row,.shiur-card,.study-segment').length,
    );
  });
}

export function PerformanceMonitor() {
  const mobile = useIsMobile();
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  useEffect(() => {
    // One percent of page loads; force with the query-free sessionStorage flag
    // in controlled fixtures. No search, recording or library data is collected.
    if (!performanceEnabled()) return;
    const metrics = clientMetrics;
    let stopped = false;
    let previous = '';
    const report = () => {
      if (!Object.keys(metrics).length) return;
      const payload = JSON.stringify({
        device: mobileRef.current ? 'mobile' : 'desktop',
        cache: performance
          .getEntriesByType('navigation')
          .some(
            (entry) =>
              (entry as PerformanceNavigationTiming).transferSize === 0,
          )
          ? 'warm'
          : 'cold',
        metrics,
      });
      if (payload === previous) return;
      if (
        navigator.sendBeacon(
          '/api/performance',
          new Blob([payload], { type: 'application/json' }),
        )
      )
        previous = payload;
    };
    void import('web-vitals').then(({ onLCP, onINP, onCLS }) => {
      if (stopped) return;
      const save = (metric: { name: string; value: number }) => {
        metrics[metric.name] = metric.value;
      };
      onLCP(save);
      onINP(save);
      onCLS(save);
    });
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
    return () => {
      stopped = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', report);
    };
  }, []);
  return null;
}
