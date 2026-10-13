import { BoundedCache } from './bounded-cache';
import {
  getDirectory,
  enrichShiur,
  normalize,
  plain,
  safeUrl,
  upstream,
  type Shiur,
  type SearchPlan,
} from './yutorah';
import type { RawShiur, SearchResponse } from './api-types';
import { dafTractates } from './daf';

export type CatalogKind =
  | 'teacher'
  | 'series'
  | 'topic'
  | 'venue'
  | 'publication'
  | 'collection';
export type BrowseKind = Exclude<CatalogKind, 'publication'>;
export type CatalogEntry = {
  id: number;
  name: string;
  count: number;
  image?: string;
  description?: string;
  group?: string;
  path?: string[];
};
export type CatalogFacets = Record<
  | 'teachers'
  | 'series'
  | 'topics'
  | 'venues'
  | 'collections'
  | 'publications'
  | 'volumes',
  CatalogEntry[]
>;
export type CatalogLanding = {
  kind: CatalogKind;
  id: number;
  name: string;
  description: string;
  image: string;
  count: number;
  recent: Shiur[];
  popular: Shiur[];
  featured: Shiur[];
  facets: CatalogFacets;
  unavailable?: string;
};
export type CollectionData = {
  id: number;
  name: string;
  description: string;
  image: string;
  count: number;
  teacherId?: number;
  items: Shiur[];
  updatedAt: string;
  related: CatalogEntry[];
};
export type DafData = {
  tractate: string;
  page: number;
  side: 'a' | 'b';
  image: string;
  items: Shiur[];
  related: Shiur[];
  sideCounts?: Partial<Record<'a' | 'b', number>>;
  tractates: { name: string; lastPage: number; id: number }[];
};
export const emptyFacets = (): CatalogFacets => ({
  teachers: [],
  series: [],
  topics: [],
  venues: [],
  collections: [],
  publications: [],
  volumes: [],
});
const cache = new BoundedCache<unknown>(64, 12 * 1024 * 1024);
const pending = new Map<string, Promise<unknown>>();

async function memo<T>(
  key: string,
  read: () => Promise<T>,
  ttl = 300_000,
): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  let request = pending.get(key);
  if (!request) {
    if (pending.size >= 24)
      throw new Error('The library is busy. Please retry.');
    request = read()
      .then((value) => {
        if (!(value && typeof value === 'object' && 'unavailable' in value))
          cache.set(key, value, ttl);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return (await request) as T;
}

async function limitedJson<T>(
  response: Response,
  limit = 8_000_000,
): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The library returned an empty response.');
  const decoder = new TextDecoder();
  let text = '',
    size = 0;
  try {
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      size += c.value.byteLength;
      if (size > limit)
        throw new Error('The library response exceeded its size limit.');
      text += decoder.decode(c.value, { stream: true });
    }
    text += decoder.decode();
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as T;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((x) => x && typeof x === 'object')
    : [];
}
export function catalogFacets(value: unknown): CatalogFacets {
  const input = value as Record<string, unknown> | undefined;
  const facets = emptyFacets();
  const fields = [
    ['teachers', 'teachers', 'TeacherId', 'TeacherName'],
    ['series', 'series', 'SeriesId', 'SeriesName'],
    ['topics', 'subcategories', 'SubcategoryId', 'Subcategoryname'],
    ['venues', 'locations', 'LocationId', 'LocationName'],
    ['collections', 'collections', 'CollectionId', 'CollectionName'],
    ['publications', 'publications', 'PublicationId', 'PublicationName'],
    [
      'volumes',
      'publicationVolumes',
      'PublicationVolumeId',
      'PublicationVolume',
    ],
  ] as const;
  for (const [kind, field, id, name] of fields) {
    const raw = input?.[field];
    facets[kind] = records(raw)
      .map((x) => ({
        id: Number(x[id]),
        name: plain(x[name]),
        count: Number(x.Match) || 0,
        image: safeUrl(x.imageURL),
        ...(kind === 'volumes' ? { group: plain(x.PublicationName) } : {}),
      }))
      .filter((x) => Number.isSafeInteger(x.id) && x.id > 0 && x.name);
    // The public website uses alternating facet arrays, unlike the mobile API.
    if (Array.isArray(raw) && raw.length && typeof raw[0] !== 'object') {
      const width = kind === 'volumes' ? 4 : 3;
      facets[kind] = [];
      for (let index = 0; index + width <= raw.length; index += width) {
        const offset = kind === 'volumes' ? 1 : 0;
        const entry = {
          id: Number(raw[index + offset + 1]),
          name: plain(raw[index + offset]),
          count: Number(raw[index + offset + 2]) || 0,
        };
        if (entry.id > 0 && Number.isSafeInteger(entry.id) && entry.name)
          facets[kind].push(entry);
      }
    }
  }
  return facets;
}

export async function catalogDictionary(): Promise<CatalogFacets> {
  return memo(
    'dictionary',
    async () => {
      const response = await fetch(
        'https://api.yutorah.org/search/get?searchTerm=&start=1',
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(18000),
        },
      );
      if (!response.ok)
        throw new Error('The library directory could not load.');
      const data = await limitedJson<SearchResponse>(response);
      if (!Array.isArray(data.response?.docs))
        throw new Error('The library directory is unavailable.');
      return catalogFacets(data.facet_counts?.facet_fields);
    },
    3_600_000,
  );
}

export async function catalogVenues(): Promise<CatalogEntry[]> {
  return memo('venues', async () =>
    records(await upstream('browse/venues', 3600))
      .map((x) => ({
        id: Number(x.ID),
        name: plain(x.name),
        count: Number(x.shiurCount) || 0,
        description: plain(x.description),
        group: plain(x.middleTierName),
        image: safeUrl(x.imageURL),
      }))
      .filter((x) => x.count > 0 && x.id > 0),
  );
}

export async function catalogDirectory(
  kind: CatalogKind,
  query = '',
  offset = 0,
) {
  let entries: CatalogEntry[];
  if (['teacher', 'series', 'topic'].includes(kind)) {
    const d = await getDirectory();
    entries =
      kind === 'teacher'
        ? d.teachers
        : kind === 'series'
          ? d.series
          : d.topics.map((t) => ({
              ...t,
              name: t.name,
              description: t.description,
              path: t.path,
            }));
  } else if (kind === 'venue') {
    entries = await catalogVenues();
  } else {
    const d = await catalogDictionary();
    entries = kind === 'publication' ? d.publications : d.collections;
  }
  const words = plain(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = entries
    .filter((e) =>
      words.every((word) =>
        [e.name, e.group, ...(e.path || [])]
          .join(' ')
          .toLocaleLowerCase()
          .includes(word),
      ),
    )
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    kind,
    entries: filtered.slice(offset, offset + 36),
    total: filtered.length,
    next: offset + 36 < filtered.length ? offset + 36 : null,
  };
}

function rawLandingEntries(value: unknown): CatalogEntry[] {
  return records(value)
    .map((x) => ({
      id: Number(x.typeID),
      name: plain(x.typeName),
      count: Number(x.numShiurim) || 0,
      image: safeUrl(x.imageURL),
    }))
    .filter((x) => x.id > 0 && x.name);
}
export async function catalogLanding(
  kind: Exclude<CatalogKind, 'collection'>,
  id: number,
): Promise<CatalogLanding> {
  return memo(`landing:${kind}:${id}`, async () => {
    const directory = await getDirectory();
    const list: CatalogEntry[] =
      kind === 'teacher'
        ? directory.teachers
        : kind === 'series'
          ? directory.series
          : kind === 'topic'
            ? directory.topics
            : kind === 'venue'
              ? await catalogVenues()
              : (await catalogDictionary()).publications;
    const entry = list.find((x) => x.id === id);
    if (kind === 'publication') {
      const data = await readArchiveSearch(
        {
          publicationId: id,
          term: '',
          original: '',
          max: 0,
          language: '',
          format: '',
          teacherId: 0,
          teacherName: '',
          seriesId: 0,
          seriesName: '',
          topicId: 0,
          labels: [],
        },
        '',
        1,
      ).catch(() => null);
      const fallback = await catalogDictionary();
      const publicationFacets = data
        ? catalogFacets(data.facet_counts?.facet_fields)
        : emptyFacets();
      if (!publicationFacets.volumes.length)
        publicationFacets.volumes = fallback.volumes.filter(
          (v) => v.group === entry?.name,
        );
      return {
        kind,
        id,
        name: entry?.name || 'Publication',
        description: '',
        image: '',
        count: data ? data.response.numFound : entry?.count || 0,
        recent:
          data?.response.docs.map((s) =>
            enrichShiur(normalize(s), directory),
          ) || [],
        popular: [],
        featured: [],
        facets: publicationFacets,
        ...(!data
          ? {
              unavailable:
                'YUTorah’s publication search is temporarily unavailable. Articles and publication volumes could not load.',
            }
          : {}),
      };
    }
    const type = kind === 'topic' ? 'category' : kind;
    const [raw, detail] = await Promise.all([
      upstream<Record<string, unknown>>(
        `landingpage/landing?type=${type}&value=${id}`,
        600,
      ),
      upstream<Record<string, unknown>>(
        `landingpage/landingpagedetails?type=${type}&value=${id}`,
        600,
      ),
    ]);
    if (!raw || (!plain(raw.name) && !entry))
      throw new Error('This library page could not be found.');
    const facets = emptyFacets();
    for (const [field, key] of [
      ['teachers', 'teachers'],
      ['series', 'series'],
      ['categories', 'topics'],
      ['venues', 'venues'],
      ['collections', 'collections'],
    ] as const)
      facets[key] = rawLandingEntries(detail?.[field]).map((e) => {
        const topic =
          key === 'topics'
            ? directory.topics.find((t) => t.id === e.id)
            : undefined;
        return {
          ...e,
          ...(topic
            ? {
                group: topic.group,
                path: topic.path,
                description: topic.description,
              }
            : {}),
          image:
            e.image ||
            (key === 'teachers'
              ? directory.teachers
              : key === 'series'
                ? directory.series
                : []
            ).find((x) => x.id === e.id)?.image,
        };
      });
    return {
      kind,
      id,
      name: plain(raw.name) || entry?.name || '',
      description:
        plain(raw.description) ||
        ('description' in (entry || {})
          ? plain((entry as CatalogEntry).description)
          : ''),
      image: safeUrl(raw.imageURL) || entry?.image || '',
      count: entry?.count || 0,
      recent: records(raw.recentlyAddedShiurim).map((s) =>
        enrichShiur(normalize(s as RawShiur), directory),
      ),
      popular: records(raw.topShiurim).map((s) =>
        enrichShiur(normalize(s as RawShiur), directory),
      ),
      featured: records(raw.featuredShiurim).map((s) =>
        enrichShiur(normalize(s as RawShiur), directory),
      ),
      facets,
    };
  });
}

export async function shiurCollections(ids: number[]): Promise<CatalogEntry[]> {
  const raw = await upstream<{
    data?: Record<string, unknown>[];
    isError?: boolean;
  }>(
    'collections/forshiurim?shiurIDs=' +
      ids.slice(0, 30).join(',') +
      '&take=50&teacherCollectionsOnly=false',
    600,
  );
  if (raw.isError || !Array.isArray(raw.data))
    throw new Error('Collections could not load.');
  const directory = await getDirectory();
  return raw.data.map((x) => ({
    id: Number(x.ID),
    name: plain(x.name),
    count: Array.isArray(x.shiurList) ? x.shiurList.length : 0,
    image: collectionImage(x.imageURL, directory),
  }));
}
/** Resolve YUTorah's legacy ///filename using the matching catalog asset. */
export function collectionImage(
  value: unknown,
  directory: Awaited<ReturnType<typeof getDirectory>>,
): string {
  if (typeof value !== 'string') return '';
  if (value.startsWith('///')) {
    const filename = value.slice(3);
    if (!/^[\w.-]+$/.test(filename)) return '';
    return (
      [...directory.teachers, ...directory.series].find((e) =>
        e.image.endsWith('/' + filename),
      )?.image || ''
    );
  }
  return safeUrl(value);
}
export async function catalogCollectionArtwork(id: number): Promise<string> {
  return memo(
    'collection-art:' + id,
    async () => {
      const raw = await upstream<Record<string, unknown>>(
        'collections/get?collectionID=' + id,
        600,
      );
      if (Number(raw.collectionID) !== id)
        throw new Error('Collection not found.');
      return collectionImage(raw.collectionImageURL, await getDirectory());
    },
    3_600_000,
  );
}
export async function catalogCollection(id: number): Promise<CollectionData> {
  return memo(`collection:${id}`, async () => {
    const raw = await upstream<Record<string, unknown>>(
      'collections/get?collectionID=' + id,
      600,
    );
    if (
      Number(raw.collectionID) !== id ||
      !Array.isArray(raw.collectionShiurim)
    )
      throw new Error('This collection could not be found.');
    const directory = await getDirectory();
    const items = records(raw.collectionShiurim)
      .map((s) => {
        const item = enrichShiur(normalize(s as RawShiur), directory);
        if (!item.collections?.some((c) => c.id === id))
          item.collections = [
            ...(item.collections || []),
            { id, name: plain(raw.collectionTitle) },
          ];
        return item;
      })
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id - b.id);
    const teacherId = items[0]?.teacherId;
    let related: CatalogEntry[] = [];
    if (teacherId) {
      const landing = await catalogLanding('teacher', teacherId).catch(
        () => null,
      );
      related = (landing?.facets.collections || [])
        .filter((x) => x.id !== id)
        .slice(0, 12);
    }
    return {
      id,
      name: plain(raw.collectionTitle),
      description: plain(raw.collectionDescription),
      image: collectionImage(raw.collectionImageURL, directory),
      count: items.length,
      teacherId,
      items,
      updatedAt: items.reduce((date, s) => (s.date > date ? s.date : date), ''),
      related,
    };
  });
}

export function archiveSearchParameters(
  plan: SearchPlan,
  query: string,
  page: number,
) {
  const fields = ['teacherishidden:0'];
  for (const [key, field, value] of [
    ['teacher', 'teacherid', plan.teacherId],
    ['series', 'seriesid', plan.seriesId],
    ['topic', 'subcategoryid', plan.topicId],
    ['venue', 'locationid', plan.venueId],
    ['collection', 'collectionid', plan.collectionId],
    ['publication', 'publicationid', plan.publicationId],
    ['volume', 'publicationvolumeid', plan.volumeId],
  ] as const) {
    const ids = plan.entityIds?.[key] || (value ? [value] : []);
    if (ids.length)
      fields.push(
        `${field}:${ids.length === 1 ? ids[0] : '(' + ids.join(' OR ') + ')'}`,
      );
  }
  return new URLSearchParams({
    organizationID: '301',
    page: String(page),
    search_query: query,
    sort_by: 'shiurdate desc,shiurid desc',
    facet_query: fields.join(','),
  });
}

export async function readArchiveSearch(
  plan: SearchPlan,
  query: string,
  page: number,
): Promise<SearchResponse> {
  const read = (nativePage: number) =>
    memo(
      'archive:' + archiveSearchParameters(plan, query, nativePage),
      async () => {
        const response = await fetch(
          'https://yutorah.org/Search/GetSearchResults?' +
            archiveSearchParameters(plan, query, nativePage),
          {
            headers: {
              Accept: 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
            },
            signal: AbortSignal.timeout(18000),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            'Publication search could not load from YUTorah. Please retry.',
          );
        }
        const raw = await limitedJson<SearchResponse>(response);
        if (
          !Array.isArray(raw.response?.docs) ||
          !Number.isSafeInteger(raw.response.numFound)
        )
          throw new Error('YUTorah returned an incomplete publication search.');
        return raw;
      },
      60000,
    );
  const first = await read(1),
    size = first.response.docs.length;
  if (!first.response.numFound) return first;
  if (!size)
    throw new Error('YUTorah returned an incomplete publication search.');
  // The website and mobile API can use different page sizes. Our scanner uses 30.
  const start = (page - 1) * 30,
    length = Math.min(30, Math.max(0, first.response.numFound - start));
  const nativeStart = Math.floor(start / size) + 1,
    nativeEnd = Math.floor((start + Math.max(0, length - 1)) / size) + 1;
  const batches = await Promise.all(
    Array.from({ length: nativeEnd - nativeStart + 1 }, (_, i) =>
      read(nativeStart + i),
    ),
  );
  if (batches.some((b) => b.response.numFound !== first.response.numFound))
    throw new Error(
      'The publication changed during this search. Please retry.',
    );
  return {
    ...first,
    response: {
      ...first.response,
      docs: batches
        .flatMap((b) => b.response.docs)
        .slice(start % size, (start % size) + length),
    },
  };
}

export async function catalogDaf(
  tractate: string,
  page: number,
  side: 'a' | 'b',
): Promise<DafData> {
  return memo(`daf:${tractate}:${page}:${side}`, async () => {
    const raw = await upstream<Record<string, unknown>>(
      'browse/daf?' +
        new URLSearchParams({
          masechta: tractate,
          daf: String(page),
          amud: side,
        }),
      600,
    );
    const tractates = dafTractates;
    const [directory, other] = await Promise.all([
      getDirectory(),
      upstream<Record<string, unknown>>(
        'browse/daf?' +
          new URLSearchParams({
            masechta: tractate,
            daf: String(page),
            amud: side === 'a' ? 'b' : 'a',
          }),
        600,
      ).catch(() => null),
    ]);
    const count = (data: Record<string, unknown>) =>
      new Set(
        [...records(data.dafYomiShiurim), ...records(data.relatedShiurim)].map(
          (s) => s.shiurID,
        ),
      ).size;
    const sideCounts = {
      [side]: count(raw),
      ...(other ? { [side === 'a' ? 'b' : 'a']: count(other) } : {}),
    };
    const image = safeUrl(raw['dafImageURL_' + side]);
    if (!image)
      throw new Error('This daf is not available. Choose another page.');
    return {
      tractate,
      page,
      side,
      image,
      items: records(raw.dafYomiShiurim).map((x) =>
        enrichShiur(normalize(x as RawShiur), directory),
      ),
      related: records(raw.relatedShiurim).map((x) =>
        enrichShiur(normalize(x as RawShiur), directory),
      ),
      sideCounts,
      tractates,
    };
  });
}
