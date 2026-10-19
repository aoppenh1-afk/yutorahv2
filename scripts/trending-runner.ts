import type { DiscoveryData, TrendingPeriod } from '../lib/trending';

/** Run bounded work. Time limits checkpoint a census; they never certify it. */
export async function runTrendingWarm({
  base,
  token,
  refresh,
  minutes,
  periods,
  maxPasses,
  maxRuntimeMs = 20 * 60 * 1000,
  now = Date.now,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}: {
  base: URL;
  token?: string;
  refresh: boolean;
  minutes: number;
  periods: TrendingPeriod[];
  maxPasses: number;
  maxRuntimeMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}): Promise<'reconciled' | 'deferred' | 'pass-limit'> {
  const started = now();
  let passes = 0,
    failures = 0,
    unchanged = 0,
    lastProgress = '';
  for (const period of periods) {
    const url = new URL(
      refresh ? '/api/discover/refresh' : '/api/discover',
      base,
    );
    url.search = new URLSearchParams({
      period,
      minutes: String(minutes),
    }).toString();
    let done = false;
    while (passes < maxPasses) {
      const remaining = maxRuntimeMs - (now() - started);
      if (remaining <= 0) {
        log(
          'Work budget reached. Saved indexing progress will resume on the next run.',
        );
        return 'deferred';
      }
      passes++;
      let response: Response | undefined;
      let data: DiscoveryData | undefined;
      let retrySeconds = 30;
      try {
        response = await fetch(url, {
          method: refresh ? 'POST' : 'GET',
          headers: refresh ? { Authorization: `Bearer ${token}` } : undefined,
          redirect: refresh ? 'error' : 'follow',
          signal: AbortSignal.timeout(Math.min(60000, remaining)),
        });
        if (response.status === 503) {
          const failure = (await response.json().catch(() => null)) as {
            code?: string;
          } | null;
          if (failure?.code === 'DATABASE_QUOTA_EXCEEDED') {
            log(
              'Database quota exhausted. Deferring refresh until database access is restored.',
            );
            return 'deferred';
          }
          if (!refresh && !['day', 'week'].includes(period))
            throw new Error(
              `${period}: saved chart is not ready; use --refresh with TRENDING_REFRESH_TOKEN to resume the shared scan.`,
            );
          retrySeconds = Number(response.headers.get('Retry-After')) || 30;
        } else {
          if (!response.ok)
            throw new Error(
              `${period}: server returned ${response.status}; rerun to resume the saved cursor.`,
            );
          data = (await response.json()) as DiscoveryData;
          if (data.period !== period || data.minutes !== minutes)
            throw new Error('The server returned a different chart.');
        }
      } catch (error) {
        // Configuration and non-retryable HTTP errors should remain visible.
        if (response && response.status !== 503 && response.status < 500)
          throw error;
        if (
          error instanceof Error &&
          /different chart|saved chart is not ready/.test(error.message)
        )
          throw error;
        log(
          `${period}: request failed (${error instanceof Error ? error.message : 'network error'}); saved cursor preserved`,
        );
      }
      if (!data || data.stale) {
        failures++;
        log(
          `${period}: refresh unavailable${data ? `; saved ${data.sampled}/${data.libraryTotal ?? data.total} indexed records preserved` : ''}; retry ${failures}/3`,
        );
        if (
          failures >= 3 ||
          retrySeconds * 1000 >= maxRuntimeMs - (now() - started)
        ) {
          log(
            'Upstream or refresh service unavailable. Deferring without discarding progress.',
          );
          return 'deferred';
        }
        await sleep(
          Math.min(
            maxRuntimeMs - (now() - started),
            Math.max(30000 * 2 ** (failures - 1), retrySeconds * 1000),
          ),
        );
        continue;
      }
      failures = 0;
      const coverage = data.coverage;
      log(
        `${period}: ${data.sampled}/${data.libraryTotal ?? data.total} indexed` +
          (coverage
            ? `; ${coverage.status}; census ${coverage.sweepSampled}; round ${coverage.round}; cursor ${coverage.cursor}; ${coverage.pendingPages} pending pages; ${coverage.requests} requests; ${coverage.added} added`
            : '') +
          (!data.partial && !data.refreshing
            ? coverage
              ? ', observed census reconciled (no upstream snapshot guarantee)'
              : data.source === 'mobile'
                ? ', legacy coverage unaudited'
                : ', complete'
            : ''),
      );
      if (coverage?.status === 'paused') {
        log(
          `${coverage.reason ?? 'Coverage unresolved.'} Resume after ${coverage.retryAt ? new Date(coverage.retryAt).toISOString() : 'upstream recovery'}.`,
        );
        return 'deferred';
      }
      if (!data.partial && !data.refreshing) {
        if (data.source === 'mobile' && !coverage) {
          log(
            'The deployed refresher does not expose audited coverage. Deploy the census implementation before certifying this index.',
          );
          return 'deferred';
        }
        if (
          data.source === 'mobile' &&
          (coverage!.status !== 'reconciled' ||
            coverage!.guaranteed !== false ||
            coverage!.pendingPages !== 0 ||
            data.sampled !== data.libraryTotal ||
            coverage!.sweepSampled !== data.libraryTotal)
        )
          throw new Error(
            'The refresher returned inconsistent completion evidence.',
          );
        done = true;
        break;
      }
      const progress = JSON.stringify([
        data.before,
        data.sampled,
        coverage?.cursor,
        coverage?.round,
        coverage?.sweepSampled,
      ]);
      unchanged = progress === lastProgress ? unchanged + 1 : 0;
      lastProgress = progress;
      // Server cursor movement counts as work even when pages contain known
      // IDs. Old deployments expose no cursor: stop their count-only stall.
      if (unchanged >= 3) {
        log(
          'Indexing stalled across four responses. Coverage remains unresolved; saved progress preserved.',
        );
        return 'deferred';
      }
      await sleep(
        Math.min(3100, Math.max(0, maxRuntimeMs - (now() - started))),
      );
    }
    if (!done) {
      log('Pass limit reached. Rerun this command to resume.');
      return 'pass-limit';
    }
  }
  return 'reconciled';
}
