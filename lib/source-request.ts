const transient = new Set([429, 500, 502, 503, 504]);
export function sourceRetryDelay(
  header: string | null,
  attempt = 0,
  now = Date.now(),
) {
  const requested =
    header && /^\d+$/.test(header)
      ? Number(header) * 1000
      : header
        ? Date.parse(header) - now
        : 0;
  return Math.min(
    60000,
    Math.max(1000 * 2 ** attempt, Number.isFinite(requested) ? requested : 0),
  );
}
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });

/** Bounded retries preserve published results and respect the upstream's Retry-After. */
export async function sourceRequest(
  url: string,
  signal: AbortSignal,
  dependencies: {
    fetcher?: typeof fetch;
    wait?: typeof pause;
    onRetry?: () => void;
  } = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await (dependencies.fetcher || fetch)(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      });
      if (response.ok) return response;
      if (!transient.has(response.status) || attempt >= 4) {
        const body = await response.json().catch(() => null);
        throw new PermanentSourceError(
          body?.error || 'Sources are temporarily unavailable. Please retry.',
        );
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof PermanentSourceError || attempt >= 4) throw error;
    }
    dependencies.onRetry?.();
    await (dependencies.wait || pause)(
      sourceRetryDelay(response?.headers.get('Retry-After') || null, attempt),
      signal,
    );
  }
}
class PermanentSourceError extends Error {}
