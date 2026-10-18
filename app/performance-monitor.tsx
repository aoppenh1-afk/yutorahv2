'use client';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  clientMetrics,
  performanceEnabled,
  performanceCount,
  type DataCommitTiming,
} from '@/lib/client-performance';

export function DataCommitMarker({
  timings,
}: {
  timings: DataCommitTiming | DataCommitTiming[];
}) {
  useLayoutEffect(() => {
    if (Array.isArray(timings)) timings.forEach((record) => record?.());
    else timings?.();
  }, [timings]);
  return null;
}

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
    let stopped = false;
    let cleanup: (() => void) | undefined;
    void import('@/lib/performance-reporter')
      .then(({ observeClientPerformance }) => {
        if (!stopped)
          cleanup = observeClientPerformance(() =>
            mobileRef.current ? 'mobile' : 'desktop',
          );
      })
      .catch(() => {
        /* Diagnostics must not interrupt the application. */
      });
    return () => {
      stopped = true;
      cleanup?.();
    };
  }, []);
  return null;
}
