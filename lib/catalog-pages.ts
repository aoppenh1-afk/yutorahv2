import type { CollectionData } from './catalog';
import type { Shiur } from './yutorah';

export type CollectionOrder = 'old' | 'new' | 'title';
export type CollectionPageData = Omit<CollectionData, 'items' | 'related'> & {
  items: Shiur[];
  version: string;
  offset: number;
  next: number | null;
  total: number;
  order: CollectionOrder;
  query: string;
  stale: boolean;
  preparedAt?: number;
  /** Canonical oldest-first membership lets Continue learning stay local. */
  lessonIds?: number[];
};
export type CollectionNeighbors = {
  id: number;
  name: string;
  version: string;
  count: number;
  index: number;
  current: Shiur | null;
  previous: Shiur | null;
  next: Shiur | null;
};
export function pageCollection(
  data: CollectionData,
  version: string,
  {
    offset = 0,
    limit = 60,
    query = '',
    order = 'old',
    stale = false,
  }: {
    offset?: number;
    limit?: number;
    query?: string;
    order?: CollectionOrder;
    stale?: boolean;
  } = {},
): CollectionPageData {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    query.length > 100 ||
    !['old', 'new', 'title'].includes(order)
  )
    throw new RangeError('Choose a valid collection page.');
  const term = query.trim().toLocaleLowerCase();
  const matches = data.items.filter(
    (s) =>
      !term ||
      [s.title, s.teacher, s.description]
        .join(' ')
        .toLocaleLowerCase()
        .includes(term),
  );
  matches.sort((a, b) =>
    order === 'title'
      ? a.title.localeCompare(b.title) || a.id - b.id
      : order === 'new'
        ? (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.id - a.id
        : (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0) || a.id - b.id,
  );
  const { items: _items, related: _related, ...metadata } = data;
  return {
    ...metadata,
    items: matches.slice(offset, offset + limit),
    version,
    offset,
    next: offset + limit < matches.length ? offset + limit : null,
    total: matches.length,
    order,
    query,
    stale,
    ...(offset === 0 ? { lessonIds: data.items.map((s) => s.id) } : {}),
  };
}
export function collectionNeighbors(
  data: CollectionData,
  version: string,
  id: number,
): CollectionNeighbors {
  const index = data.items.findIndex((s) => s.id === id);
  return {
    id: data.id,
    name: data.name,
    version,
    count: data.items.length,
    index,
    current: data.items[index] ?? null,
    previous: index > 0 ? data.items[index - 1] : null,
    next: index >= 0 ? (data.items[index + 1] ?? null) : null,
  };
}
