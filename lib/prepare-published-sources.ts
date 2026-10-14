import { setTimeout as delay } from 'node:timers/promises';

/** Optional post-publication warm-up. A Sefaria outage never fails a completed transcription. */
export async function preparePublishedSources(
  shiurId: string,
  signal: AbortSignal,
  dependencies: {
    url?: string;
    token?: string;
    fetcher?: typeof fetch;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    report?: (event: { event: string; code?: string }) => void;
    transcriptId?: string;
    version?: string;
  } = {},
) {
  const url = dependencies.url || process.env.SOURCES_PREPARE_URL;
  const token = dependencies.token || process.env.SOURCES_PREPARE_TOKEN;
  if (!url || !token) return false;
  const report = dependencies.report || (() => {});
  try {
    const target = new URL(url);
    if (
      target.username ||
      target.password ||
      !(
        target.protocol === 'https:' ||
        (target.protocol === 'http:' && target.hostname === '127.0.0.1')
      )
    )
      throw new Error('Invalid preparation endpoint');
    const deadline = Date.now() + 5 * 60 * 1000;
    let failures = 0;
    for (
      let pass = 0;
      pass < 120 && !signal.aborted && Date.now() < deadline;
      pass++
    ) {
      let response: Response;
      try {
        response = await (dependencies.fetcher || fetch)(target, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            shiurId,
            ...(dependencies.transcriptId
              ? { transcriptId: dependencies.transcriptId }
              : {}),
            ...(dependencies.version ? { version: dependencies.version } : {}),
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        });
      } catch {
        if (signal.aborted || ++failures > 4)
          throw new Error('Preparation unavailable');
        await (
          dependencies.wait ||
          ((ms, signal) => delay(ms, undefined, { signal }))
        )(1000 * 2 ** failures, signal);
        continue;
      }
      if (response.status === 200) {
        const data = (await response.json()) as {
          status?: unknown;
          transcriptId?: unknown;
        } | null;
        if (
          data?.status !== 'ready' ||
          typeof data.transcriptId !== 'string' ||
          (dependencies.transcriptId &&
            data.transcriptId !== dependencies.transcriptId)
        )
          throw new Error('Unsupported preparation response');
        report({ event: 'sources_prepared' });
        return true;
      }
      // Superseded transcript identities are finished, not retried indefinitely.
      if (response.status === 409) return true;
      if (![202, 429, 500, 502, 503, 504].includes(response.status))
        throw new Error('Preparation rejected');
      if (response.status === 202) failures = 0;
      else if (++failures > 4) throw new Error('Preparation unavailable');
      const retry = Number(response.headers.get('Retry-After')) * 1000;
      await (
        dependencies.wait || ((ms, signal) => delay(ms, undefined, { signal }))
      )(
        Math.min(60000, Math.max(2000, Number.isFinite(retry) ? retry : 2000)),
        signal,
      );
    }
    report({ event: 'sources_preparation_deferred' });
  } catch {
    if (!signal.aborted)
      report({ event: 'sources_preparation_deferred', code: 'unavailable' });
  }
  return false;
}
