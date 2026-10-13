import type { DiscoveryData, TrendingOptions } from './trending';
import {
  readLocalDiscoveryCharts,
  rememberDiscoveryChart,
  preferDiscoveryChart,
} from './trending-local';

/** Fetch saved server rankings without starting a scan, including on Home. */
export async function loadSavedDiscovery(
  options: TrendingOptions,
  signal: AbortSignal,
  onData: (data: DiscoveryData) => void,
  cache = { read: readLocalDiscoveryCharts, save: rememberDiscoveryChart },
): Promise<void> {
  const query = new URLSearchParams({
    period: options.period,
    minutes: String(options.minutes),
    cached: '1',
  });
  const response = await fetch('/api/discover?' + query, { signal });
  if (!response.ok || signal.aborted) return;
  const data = (await response.json()) as DiscoveryData;
  if (data.period !== options.period || data.minutes !== options.minutes)
    throw new Error('Discovery returned a different chart');
  if (!signal.aborted) onData(cache.save(data));
}

/** Publish saved rankings while the daily/weekly request advances the index. */
export async function loadDiscovery(
  options: TrendingOptions,
  signal: AbortSignal,
  onData: (data: DiscoveryData) => void,
  onRetry: (seconds: number) => void,
  loadSaved: boolean,
  cache = { read: readLocalDiscoveryCharts, save: rememberDiscoveryChart },
): Promise<void> {
  const query = new URLSearchParams({
    period: options.period,
    minutes: String(options.minutes),
  });
  let updated = false;
  let visible = cache.read()[`${options.period}:${options.minutes}`];
  if (visible && !signal.aborted) onData(visible);
  const publish = async (res: Response, saved: boolean) => {
    const data = (await res.json()) as DiscoveryData;
    if (data.period !== options.period || data.minutes !== options.minutes)
      throw new Error('Discovery returned a different chart');
    if (signal.aborted || (saved && updated)) return;
    if (!saved) updated = true;
    visible = preferDiscoveryChart(visible, data);
    visible = cache.save(visible);
    onData(visible);
    // Only the indexing request controls polling; a cached response is stale
    // by design and must not override its newer retry decision.
    if (!saved && data.coverage?.retryAt && data.coverage.retryAt > Date.now())
      onRetry(
        Math.max(5, Math.ceil((data.coverage.retryAt - Date.now()) / 1000)),
      );
    else if (!saved && data.stale) onRetry(30);
  };
  if (loadSaved && (options.period === 'day' || options.period === 'week')) {
    void fetch('/api/discover?' + query + '&cached=1', { signal })
      .then((res) => (res.ok ? publish(res, true) : undefined))
      .catch(() => {
        // A missing saved chart leaves the regular request in charge.
      });
  }
  const res = await fetch('/api/discover?' + query, { signal });
  if (!res.ok) {
    if ((res.status === 503 || res.status === 502) && !signal.aborted)
      onRetry(
        Math.min(30, Math.max(5, Number(res.headers.get('Retry-After')) || 30)),
      );
    throw new Error('Discovery unavailable');
  }
  await publish(res, false);
}
