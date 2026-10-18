import {
  cachedCatalogResource,
  loadCatalogResource,
  invalidateCatalogResource,
} from './catalog-client';
import type {
  CollectionPageData,
  CollectionOrder,
  CollectionNeighbors,
} from './catalog-pages';
import type { Shiur } from './yutorah';

export function collectionPageUrl(
  id: number,
  {
    offset = 0,
    query = '',
    order = 'old',
    version = '',
  }: {
    offset?: number;
    query?: string;
    order?: CollectionOrder;
    version?: string;
  } = {},
) {
  const params = new URLSearchParams({
    action: 'entity',
    kind: 'collection',
    id: String(id),
    offset: String(offset),
    q: query,
    sort: order,
  });
  if (version) params.set('version', version);
  return '/api/catalog?' + params;
}
export function loadCollectionPage(
  id: number,
  options: Parameters<typeof collectionPageUrl>[1] = {},
  signal?: AbortSignal,
) {
  return loadCatalogResource<CollectionPageData>(
    collectionPageUrl(id, options),
    signal,
  );
}
export function cachedCollectionPage(
  id: number,
  options: Parameters<typeof collectionPageUrl>[1] = {},
) {
  return cachedCatalogResource<CollectionPageData>(
    collectionPageUrl(id, options),
  );
}
/** Complete actions pin every page and reject missing/duplicate lessons. */
export async function loadCollectionItems(
  id: number,
  version: string,
  signal?: AbortSignal,
  onProgress?: (count: number, total: number) => void,
) {
  const items: Shiur[] = [];
  const seen = new Set<number>();
  let offset = 0;
  let count: number | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await loadCollectionPage(id, { offset, version }, signal);
    count ??= page.count;
    if (
      page.version !== version ||
      page.count !== count ||
      page.offset !== offset
    )
      throw new Error(
        'The collection changed. Reload it before adding all lessons.',
      );
    if (!page.items.length && page.next !== null)
      throw new Error('The collection returned an incomplete page.');
    for (const item of page.items) {
      if (seen.has(item.id))
        throw new Error('The collection returned a duplicate lesson.');
      seen.add(item.id);
      items.push(item);
    }
    onProgress?.(items.length, count);
    if (page.next === null) break;
    if (page.next <= offset || page.next !== items.length)
      throw new Error('The collection returned an invalid page.');
    offset = page.next;
  }
  if (items.length !== count)
    throw new Error(
      'The collection returned an incomplete list. Please retry.',
    );
  return items;
}
export function collectionNeighborsUrl(
  id: number,
  shiur: number,
  version = '',
) {
  const params = new URLSearchParams({
    action: 'neighbors',
    kind: 'collection',
    id: String(id),
    shiur: String(shiur),
  });
  if (version) params.set('version', version);
  return '/api/catalog?' + params;
}
export function loadCollectionNeighbors(
  id: number,
  shiur: number,
  version = '',
  signal?: AbortSignal,
  retry = false,
) {
  const url = collectionNeighborsUrl(id, shiur, version);
  if (retry) invalidateCatalogResource(url);
  return loadCatalogResource<CollectionNeighbors>(url, signal);
}
