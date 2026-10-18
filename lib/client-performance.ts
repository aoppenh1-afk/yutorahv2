'use client';
let sampled: boolean | undefined;
export const clientMetrics: Record<string, number> = {};
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
export function recordDataVisible(
  area: 'home' | 'search' | 'collection' | 'shiur' | 'catalog',
  started: number,
) {
  if (!performanceEnabled()) return;
  requestAnimationFrame(() =>
    performanceCount(area + 'VisibleMs', performance.now() - started),
  );
}
