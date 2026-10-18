import type { BrowseKind, CatalogEntry } from './catalog';
import type { Directory, Shiur } from './yutorah';
import { combineSearchSuggestions, suggestSearch } from './search-discovery';

export type CatalogSearchMatch = CatalogEntry & { kind: BrowseKind };
export type CatalogSearchResult = {
  items: CatalogSearchMatch[];
  total: number;
  next: number | null;
  partial: boolean;
};
export type MixedSearchMatch =
  | { kind: 'shiur'; shiur: Shiur }
  | { kind: 'page'; page: CatalogSearchMatch };

export function findCatalogSearchMatches(
  query: string,
  directory: Directory | null,
  collections: CatalogEntry[],
  venues: CatalogEntry[],
): CatalogSearchMatch[] {
  if (!query.trim()) return [];
  const names = {
    ...(directory || { teachers: [], topics: [], series: [], groups: [] }),
    collections,
    venues,
  };
  const entries = new Map<string, CatalogEntry>();
  for (const [kind, items] of [
    ['teacher', names.teachers],
    ['topic', names.topics],
    ['series', names.series],
    ['collection', collections],
    ['venue', venues],
  ] as const)
    for (const item of items) entries.set(`${kind}-${item.id}`, item);
  return suggestSearch(query, names, Infinity).map((match) => ({
    ...entries.get(`${match.kind}-${match.id}`)!,
    kind: match.kind,
  }));
}

/** Rank titles together before pagination, without a content-type preference. */
export function mergeSearchMatches(
  shiurim: Shiur[],
  pages: CatalogSearchMatch[],
  query: string,
  order = 'relevance',
): MixedSearchMatch[] {
  if (!pages.length && !['relevance', 'title'].includes(order))
    return shiurim.map((shiur) => ({ kind: 'shiur', shiur }));
  const entries = new Map<string, MixedSearchMatch>();
  for (const shiur of shiurim)
    entries.set(`shiur-${shiur.id}`, { kind: 'shiur', shiur });
  for (const page of pages)
    entries.set(`${page.kind}-${page.id}`, { kind: 'page', page });
  const ranked = combineSearchSuggestions(
    pages.map((page) => ({ ...page, context: page.kind })),
    shiurim.map((shiur) => ({
      id: shiur.id,
      kind: 'shiur' as const,
      name: shiur.title,
      context: 'Shiur',
    })),
    query,
    Infinity,
  );
  if (order === 'title')
    ranked.sort((a, b) => a.name.localeCompare(b.name) || b.id - a.id);
  return ranked.map((match) => entries.get(`${match.kind}-${match.id}`)!);
}
