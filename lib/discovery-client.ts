import type { DiscoveryData, TrendingOptions } from './trending';

/** Publish saved rankings while the daily/weekly request advances the index. */
export async function loadDiscovery(
  options: TrendingOptions,
  signal: AbortSignal,
  onData: (data: DiscoveryData) => void,
  onRetry: (seconds: number) => void,
  loadSaved: boolean,
): Promise<void> {
  const query = new URLSearchParams({
    period: options.period,
    minutes: String(options.minutes),
  });
  let updated = false;
  const publish = async (res: Response, saved: boolean) => {
    const data = (await res.json()) as DiscoveryData;
    if (data.period !== options.period || data.minutes !== options.minutes)
      throw new Error('Discovery returned a different chart');
    if (signal.aborted || (saved && updated)) return;
    if (!saved) updated = true;
    onData(data);
    // Only the indexing request controls polling; a cached response is stale
    // by design and must not override its newer retry decision.
    if (!saved && data.stale) onRetry(30);
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
