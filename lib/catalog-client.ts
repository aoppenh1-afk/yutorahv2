import { BoundedCache } from './bounded-cache';
import {
  performanceCount,
  performanceEnabled,
  responseDataSource,
  type DataSource,
} from './client-performance';

/** Public catalog data only. Account data must never use this loader. */
type Entry = { data: unknown; freshUntil: number };
const cache = new BoundedCache<Entry>(64, 4 * 1024 * 1024);
const pending = new Map<
  string,
  { promise: Promise<unknown>; generation: object; source: () => DataSource }
>();
const generations = new Map<string, object>();
const paths = [
  '/api/catalog',
  '/api/catalog-artwork',
  '/api/home',
  '/api/directory',
  '/api/shiur',
  '/api/related',
  '/api/teacher-popular',
];
export function isPublicCatalogResource(url: string) {
  return paths.includes(url.split('?')[0]);
}
function resourceKey(url: string) {
  const [path, query = ''] = url.split('?');
  if (!paths.includes(path))
    throw new Error('Only public catalog requests can use this cache.');
  const params = new URLSearchParams(query);
  params.sort();
  return path + (params.size ? '?' + params : '');
}
export function cachedCatalogResource<T>(url: string): T | undefined {
  return cache.get(resourceKey(url))?.data as T | undefined;
}
export function invalidateCatalogResource(url: string) {
  cache.delete(resourceKey(url));
  generations.delete(resourceKey(url));
}
export function loadCatalogResource<T>(
  url: string,
  signal?: AbortSignal,
  onSource?: (source: DataSource) => void,
): Promise<T> {
  signal?.throwIfAborted();
  const observe = performanceEnabled() ? onSource : undefined;
  const key = resourceKey(url);
  const hit = cache.get(key);
  if (hit && hit.freshUntil > Date.now()) {
    performanceCount('dataCacheHits', 1);
    observe?.('memory');
    return Promise.resolve(hit.data as T);
  }
  let generation = generations.get(key);
  if (!generation) {
    generation = {};
    generations.set(key, generation);
  }
  let request = pending.get(key);
  if (request?.generation !== generation) request = undefined;
  if (!request) {
    if (pending.size >= 32)
      return Promise.reject(new Error('The library is busy. Please retry.'));
    const currentGeneration = generation;
    const started = performance.now();
    let source: DataSource = 'unknown';
    const promise = (async () => {
      const deadline = AbortSignal.timeout(32_000);
      let response!: Response;
      for (let attempt = 0; attempt < 20; attempt++) {
        response = await fetch(key, {
          signal: deadline,
          credentials: 'same-origin',
        });
        const retry = Number(response.headers.get('Retry-After'));
        if (response.status !== 503 || !retry || retry > 5 || attempt === 19)
          break;
        await response.body?.cancel();
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(deadline.reason);
          };
          const timer = setTimeout(
            () => {
              deadline.removeEventListener('abort', abort);
              resolve();
            },
            Math.max(250, retry * 1000),
          );
          if (deadline.aborted) abort();
          else deadline.addEventListener('abort', abort, { once: true });
        });
      }
      if (response.status === 204) {
        source = responseDataSource(response, started);
        return null;
      }
      const data = await response.json();
      source = responseDataSource(response, started);
      if (!response.ok)
        throw new Error(data.error || 'This page could not load.');
      if (
        data &&
        typeof data === 'object' &&
        !('unavailable' in data) &&
        !('partial' in data && data.partial) &&
        generations.get(key) === currentGeneration
      ) {
        const ttl = key.startsWith('/api/catalog-artwork')
          ? 3_600_000
          : key.startsWith('/api/directory')
            ? 1_800_000
            : key.startsWith('/api/shiur?')
              ? 300_000
              : 60_000;
        cache.set(
          key,
          { data, freshUntil: Date.now() + ttl },
          ttl + 60 * 60_000,
        );
      }
      if (hit && data && typeof data === 'object' && 'unavailable' in data) {
        source = 'memory-stale';
        return hit.data;
      }
      return data;
    })()
      .catch((error: unknown) => {
        if (hit) {
          source = 'memory-stale';
          return hit.data;
        }
        throw error;
      })
      .finally(() => {
        performanceCount('dataApiCalls', 1);
        performanceCount('dataApiMs', performance.now() - started);
        if (pending.get(key)?.generation === currentGeneration)
          pending.delete(key);
        if (!cache.get(key) && generations.get(key) === currentGeneration)
          generations.delete(key);
      });
    request = { promise, generation: currentGeneration, source: () => source };
    pending.set(key, request);
    // Generations are retained only for bounded cache entries or active work.
    if (generations.size > 128)
      for (const entry of generations.keys()) {
        if (!pending.has(entry) && !cache.get(entry)) generations.delete(entry);
      }
  } else performanceCount('dataCacheCoalesced', 1);
  const current = request;
  const shared = observe
    ? current.promise.then((data) => {
        if (!signal?.aborted) observe(current.source());
        return data as T;
      })
    : (current.promise as Promise<T>);
  if (!signal) return shared;
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    shared
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export function prefetchCatalogDirectories() {
  for (const kind of ['collection', 'venue'])
    void loadCatalogResource(`/api/catalog?kind=${kind}&q=&offset=0`).catch(
      () => {},
    );
}
