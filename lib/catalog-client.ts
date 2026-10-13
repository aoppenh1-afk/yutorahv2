import { BoundedCache } from './bounded-cache';

/** Public catalog data only. Account data must never use this loader. */
const cache = new BoundedCache<unknown>(64, 4 * 1024 * 1024);
const pending = new Map<string, Promise<unknown>>();
function resourceKey(url: string) {
  const [path, query = ''] = url.split('?');
  if (!['/api/catalog', '/api/catalog-artwork'].includes(path))
    throw new Error('Only public catalog requests can use this cache.');
  const params = new URLSearchParams(query);
  params.sort();
  return path + '?' + params;
}
export function cachedCatalogResource<T>(url: string): T | undefined {
  return cache.get(resourceKey(url)) as T | undefined;
}
export function invalidateCatalogResource(url: string) {
  cache.delete(resourceKey(url));
}
export function loadCatalogResource<T>(url: string): Promise<T> {
  const key = resourceKey(url);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit as T);
  let request = pending.get(key);
  if (!request) {
    request = fetch(key, { signal: AbortSignal.timeout(18_000) })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || 'This page could not load.');
        if (data && typeof data === 'object' && !('unavailable' in data))
          cache.set(
            key,
            data,
            key.startsWith('/api/catalog-artwork?') ? 3_600_000 : 60_000,
          );
        return data;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request as Promise<T>;
}
export function prefetchCatalogDirectories() {
  for (const kind of ['collection', 'venue'])
    void loadCatalogResource(`/api/catalog?kind=${kind}&q=&offset=0`).catch(
      () => {},
    );
}
