import type { Directory } from './yutorah';
import { searchText } from './search-discovery';
export type LegacyParams = Record<string, string | string[] | undefined>;
const first = (p: LegacyParams, ...keys: string[]) =>
  keys
    .flatMap((key) => p[key] || [])
    .find((v) => v.trim())
    ?.trim() || '';
const id = (value: string) =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^[1-9]\d{0,8}$/.test(v))
    .join(',');

/** Keep original restrictions when a saved YUTorah link is opened here. */
export function legacySearchLink(p: LegacyParams) {
  const next = new URLSearchParams({ view: 'search' });
  const query = first(p, 'q', 's', 'search', 'query', 'term', 'search_query');
  if (query) next.set('q', query.slice(0, 300));
  for (const [key, aliases] of Object.entries({
    teacher: ['teacher', 'teacherID', 'teacherid'],
    series: ['series', 'seriesID', 'seriesid'],
    topic: [
      'topic',
      'category',
      'subcategory',
      'subcategoryID',
      'subCategoryID',
    ],
    venue: ['venue', 'location', 'locationID'],
    collection: ['collection', 'collectionID', 'collectionid'],
    publication: ['publication', 'publicationid', 'publicationID'],
    volume: ['volume', 'publicationvolumeid', 'publicationVolumeID'],
  })) {
    const value = id(first(p, ...aliases));
    if (value) next.set(key, value);
  }
  const sorts: Record<string, string> = {
    'shiurdate desc': 'new',
    'shiurdate asc': 'old',
    'shiurtitle asc': 'title',
    'shiurvisitsnum desc': 'popular',
  };
  const sort = first(p, 'sort', 'sort_by', 'sortBy');
  if (sort)
    next.set(
      'sort',
      sorts[sort] ||
        ([
          'new',
          'old',
          'title',
          'popular',
          'relevance',
          'short',
          'long',
          'library',
        ].includes(sort)
          ? sort
          : 'new'),
    );
  for (const key of [
    'min',
    'max',
    'language',
    'format',
    'phrase',
    'exclude',
    'scope',
    'literal',
    'after',
    'before',
    'dateBasis',
    'uploadedAfter',
    'uploadedBefore',
  ]) {
    const value = first(p, key);
    if (value) next.set(key, value);
  }
  for (const [key, basis] of [
    ['dtu', 'uploaded'],
    ['dtg', 'given'],
  ] as const) {
    const range = first(p, key);
    if (!range) continue;
    const dates = range.match(/\d{4}-\d{2}-\d{2}/g);
    if (key === 'dtg' && next.get('dateBasis') === 'uploaded') {
      if (next.get('after')) next.set('uploadedAfter', next.get('after')!);
      if (next.get('before')) next.set('uploadedBefore', next.get('before')!);
      next.delete('after');
      next.delete('before');
    }
    next.set('dateBasis', basis);
    if (dates?.length) {
      next.set('after', dates[0]);
      if (dates[1]) next.set('before', dates[1]);
    } else {
      const days: Record<string, number> = {
        today: 0,
        yesterday: 1,
        week: 7,
        thisweek: 7,
        month: 30,
        thismonth: 30,
        '1': 0,
        '2': 1,
        '7': 7,
        '30': 30,
      };
      const period = days[range.toLowerCase().replace(/\s/g, '')];
      if (period !== undefined) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - period);
        next.set('after', d.toISOString().slice(0, 10));
        if (period === 1) next.set('before', d.toISOString().slice(0, 10));
      }
    }
  }
  return '/?' + next;
}

export function entityLink(kind: string, id: number) {
  return `/?view=${kind === 'collection' ? 'collection' : 'entity'}&kind=${kind}&id=${id}`;
}
export function resolveEntitySlug(
  kind: 'teacher' | 'series' | 'topic',
  slug: string[],
  directory: Directory,
): number | undefined {
  const value = searchText(
    decodeURIComponent(slug.at(-1) || '').replace(/[-_]+/g, ' '),
  );
  const list =
    kind === 'teacher'
      ? directory.teachers
      : kind === 'series'
        ? directory.series
        : directory.topics;
  const candidates = list.filter(
    (entry) =>
      String(entry.id) === value ||
      searchText(entry.name) === value ||
      (kind === 'teacher' &&
        searchText(entry.name).replace(
          /^(rabbi|rav|dr|mrs|rebbetzin)\s+/,
          '',
        ) === value.replace(/^(rabbi|rav|dr|mrs|rebbetzin)\s+/, '')),
  );
  if (kind === 'topic' && slug.length > 1) {
    const group = searchText(slug[0]);
    const match = candidates.find(
      (e) =>
        'group' in e &&
        searchText(String(e.group)) === group &&
        (slug.length < 3 ||
          ('branch' in e &&
            searchText(String(e.branch)) === searchText(slug[1]))),
    );
    if (match) return match.id;
  }
  return candidates.length === 1 ? candidates[0].id : undefined;
}

/** Adapt only destinations we implement; retain external campaign links. */
export function nativeYutorahLink(input: string): string {
  try {
    const url = new URL(input, 'https://yutorah.org');
    if (!['yutorah.org', 'www.yutorah.org'].includes(url.hostname))
      return url.href.startsWith('https://') ? url.href : '';
    const p = Object.fromEntries(url.searchParams);
    if (
      /\/publications\/?$/i.test(url.pathname) ||
      p.publicationid ||
      p.publicationID ||
      p.publication ||
      p.publicationvolumeid ||
      p.publicationVolumeID ||
      p.volume
    )
      return url.href;
    if (/\/search\/?$/i.test(url.pathname)) {
      if ((p.collection || p.collectionID) && !p.s && !p.q)
        return entityLink('collection', Number(p.collection || p.collectionID));
      return legacySearchLink(p);
    }
    const collection = /\/collections?\/(\d+)/i.exec(url.pathname);
    if (collection) return entityLink('collection', Number(collection[1]));
    if (/\/lectures\//i.test(url.pathname)) {
      const shiur = p.shiurID || /\/lectures\/(\d+)/i.exec(url.pathname)?.[1];
      if (shiur && id(shiur)) return '/?shiur=' + shiur;
    }
    if (/\/daf\/?$/i.test(url.pathname)) return '/?view=daf';
    if (/^\/(?:teachers|series|categories|venues)(?:\/|$)/i.test(url.pathname))
      return (
        url.pathname.replace(
          /^\/(teachers|series|categories|venues)/i,
          (match) => match.toLowerCase(),
        ) + url.search
      );
    return url.href;
  } catch {
    return '';
  }
}
