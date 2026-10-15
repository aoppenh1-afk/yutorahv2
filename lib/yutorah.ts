import { naturalSearch } from './natural-search';
import { orderedTopicGroups } from './topic-groups';
import { viewCount } from './view-count';
import {
  searchText,
  teacherMention,
  directorySearchIndex,
} from './search-discovery';
import {
  intentLabels,
  interpretAliases,
  interpretSpacing,
  matchQuery,
  wordMatch,
} from './search-matching';
import type {
  RawShiur,
  RawTeacher,
  RawSeries,
  RawCategory,
  HomeResponse,
  SearchResponse,
} from './api-types';
export type Shiur = {
  id: number;
  title: string;
  teacher: string;
  teacherId: number;
  image: string;
  audio: string;
  url: string;
  duration: number;
  date: string;
  uploadedAt?: string;
  topics: string[];
  topicIds?: number[];
  views?: number;
  downloads?: number;
  category: string;
  language: string;
  series: string;
  seriesId: number;
  description: string;
  format: string;
  materials: { name: string; url: string }[];
  speakers?: { id: number; name: string; image: string }[];
  topicPaths?: { id: number; name: string; group: string; branch?: string }[];
  venueId?: number;
  venue?: string;
  publicationId?: number;
  publication?: string;
  volumeId?: number;
  volume?: string;
  collections?: { id: number; name: string; position?: number }[];
  facets?: { kind: string; id: number; name: string }[];
};
export type Series = {
  id: number;
  name: string;
  description: string;
  image: string;
  count: number;
};
export type HomeData = {
  featured: Shiur[];
  recent: Shiur[];
  recentlyViewed?: Shiur[];
  daily: Shiur[];
  series: Series[];
  total: number;
  hebrewDate: string;
  daf: string;
  nach: string;
  mishna: string;
  parsha?: string;
  fetchedAt: string;
  campaigns?: {
    id: number;
    name: string;
    description: string;
    image: string;
    url: string;
  }[];
  editorial?: { id: number; name: string; image: string; url: string }[];
};
export const ORIGIN = 'https://yutorah.org';
/** Preserve editorial order, with a playable rabbi-led recording for the hero. */
export function selectHomeFeature(home: HomeData | null): Shiur | undefined {
  if (!home) return undefined;
  return [...home.featured, ...home.recent, ...home.daily].find(
    (s) => /^Rabbi\b/i.test(s.teacher) && mediaKind(s) === 'audio' && !!s.audio,
  );
}
export function plain(value: unknown): string {
  return (
    typeof value === 'string'
      ? value
      : typeof value === 'number'
        ? String(value)
        : ''
  )
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
export function safeUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const u = new URL(value, ORIGIN);
    return u.protocol === 'https:' || u.protocol === 'http:'
      ? u.href.replace(/^http:/, 'https:')
      : '';
  } catch {
    return '';
  }
}
/** The legacy website serializes Eastern wall time; the mobile API includes Z. */
export function uploadDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let input = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(input)) {
    const wall = Date.parse(input + 'Z');
    if (!Number.isFinite(wall)) return undefined;
    const eastern = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    let instant = wall;
    for (let pass = 0; pass < 2; pass++) {
      const parts = Object.fromEntries(
        eastern.formatToParts(instant).map((p) => [p.type, p.value]),
      );
      const local = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      instant = wall - (local - Math.floor(instant / 1000) * 1000);
    }
    input = new Date(instant).toISOString();
  }
  // A date without a time or offset cannot establish a 24-hour cutoff.
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) return undefined;
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}
const dateBoundaries = new Map<string, string>();
/** Uploaded calendar days follow YUTorah's New York timestamps. */
export function dateBoundary(
  day: string,
  uploaded = false,
  exclusiveEnd = false,
): string {
  const key = `${day}:${uploaded}:${exclusiveEnd}`,
    cached = dateBoundaries.get(key);
  if (cached) return cached;
  const date = exclusiveEnd
    ? new Date(Date.parse(day + 'T00:00:00Z') + 86400000)
        .toISOString()
        .slice(0, 10)
    : day;
  const result = uploaded
    ? uploadDate(date + 'T00:00:00')!
    : date + 'T00:00:00.000Z';
  dateBoundaries.set(key, result);
  if (dateBoundaries.size > 128)
    dateBoundaries.delete(dateBoundaries.keys().next().value!);
  return result;
}
export function normalize(raw: RawShiur): Shiur {
  const teacher = raw.shiurTeachers?.[0];
  const seconds = String(raw.shiurLength ?? '0:0:0')
    .split(':')
    .reduce((s: number, n: string) => s * 60 + Number(n), 0);
  const legacyPhoto =
    raw.PHOTO || (Array.isArray(raw.photo) ? raw.photo[0] : raw.photo);
  const photo =
    teacher?.teacherPhotoURL ||
    (legacyPhoto
      ? 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/' + legacyPhoto
      : '');
  const id = Number(raw.shiurID ?? raw.shiurid);
  const array = <T>(value: T | T[] | undefined | null): T[] =>
    Array.isArray(value) ? value : value == null ? [] : [value];
  const names = array(raw.teacherfullname);
  const teacherIds = array(raw.teacherid);
  const photos = array(raw.photo);
  const speakers = raw.shiurTeachers?.length
    ? raw.shiurTeachers.map((t) => ({
        id: t.teacherID,
        name: plain(t.teacherName),
        image: safeUrl(t.teacherPhotoURL),
      }))
    : names.map((name, index) => ({
        id: Number(teacherIds[index]) || 0,
        name: plain(name),
        image:
          index === 0
            ? safeUrl(photo)
            : photos[index]
              ? safeUrl(
                  'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/' +
                    photos[index],
                )
              : '',
      }));
  const collections = (raw.collectionid || []).map((collectionId, index) => {
    const parts = String(raw.collectionname?.[index] || '').split('|');
    return {
      id: collectionId,
      name: plain(parts[0]),
      ...(Number(parts[2]) > 0 ? { position: Number(parts[2]) } : {}),
    };
  });
  const result: Shiur = {
    id,
    title: plain(raw.shiurTitle ?? raw.shiurtitle),
    teacher: plain(
      teacher?.teacherName ??
        (Array.isArray(raw.teacherfullname)
          ? raw.teacherfullname[0]
          : raw.teacherfullname),
    ),
    teacherId: Number(
      teacher?.teacherID ??
        (Array.isArray(raw.teacherid) ? raw.teacherid[0] : raw.teacherid),
    ),
    image: safeUrl(photo),
    audio: safeUrl(raw.downloadURL || raw.shiurFileURL || raw.shiurdownloadurl),
    url: `${ORIGIN}/lectures/details?shiurID=${id}`,
    duration: raw.duration ? Number(raw.duration) * 60 : Math.round(seconds),
    date: String(raw.shiurDate ?? raw.shiurdate ?? '').replace(
      /^(\d{4}-\d{2}-\d{2}T[\d:.]+)$/,
      '$1Z',
    ),
    uploadedAt: uploadDate(raw.shiurDateSubmitted ?? raw.shiurdatesubmitted),
    topics: (
      raw.shiurSubcategoriesObj?.map((s) => s.name) ??
      raw.subcategoryname ??
      []
    ).map(plain),
    topicIds: (
      raw.shiurSubcategoriesObj?.map((s) => s.subCategoryID) ??
      raw.shiurSubcategories ??
      raw.subcategoryid ??
      []
    ).filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0),
    views: viewCount(raw.shiurvisitsnum),
    downloads:
      Number.isFinite(raw.shiurdownloadsnum) &&
      Number(raw.shiurdownloadsnum) >= 0
        ? Number(raw.shiurdownloadsnum)
        : undefined,
    category: plain(
      raw.shiurSubcategoriesObj?.[0]?.categoryShortName ??
        raw.categoryname?.[0],
    ),
    language: raw.shiurLanguage ?? raw.language ?? '',
    series: plain(raw.shiurSeriesName ?? raw.seriesname?.[0]),
    seriesId: Number(raw.shiurSeries ?? raw.seriesid?.[0] ?? 0),
    description: plain(raw.shiurDescription ?? raw.shiurdescription),
    format: String(raw.shiurMediaType ?? raw.mediatypename ?? '').toLowerCase(),
    materials: [],
    speakers,
    topicPaths:
      raw.shiurSubcategoriesObj?.map((topic) => ({
        id: Number(topic.subCategoryID || topic.ID),
        name: plain(topic.name),
        group: plain(topic.categoryShortName || topic.categoryName),
        branch: plain(topic.middleTierName),
      })) ||
      (raw.subcategoryid || []).map((topicId, index) => ({
        id: topicId,
        name: plain(raw.subcategoryname?.[index]),
        group: plain(raw.categoryname?.[index]),
      })),
    venueId: Number(raw.shiurVenue || array(raw.locationid)[0]) || undefined,
    venue: plain(raw.shiurVenueName || raw.location),
    publicationId:
      Number(raw.shiurPublicationId || array(raw.publicationid)[0]) ||
      undefined,
    publication: plain(
      raw.shiurPublicationName || array(raw.publicationname)[0],
    ),
    // Mobile details use "shiurPublication" for the volume key.
    volumeId:
      Number(
        raw.shiurPublicationVolumeKey ||
          raw.shiurPublication ||
          array(raw.publicationvolumeid)[0],
      ) || undefined,
    volume: plain(
      raw.shiurPublicationVolumeName || array(raw.publicationvolumename)[0],
    ),
    collections,
  };
  result.facets = [
    ...speakers.map((x) => ({ kind: 'teachers', id: x.id, name: x.name })),
    ...(result.topicPaths || []).map((x) => ({
      kind: 'topics',
      id: x.id,
      name: [x.group, x.branch, x.name].filter(Boolean).join(' / '),
    })),
    ...(result.seriesId
      ? [{ kind: 'series', id: result.seriesId, name: result.series }]
      : []),
    ...(result.venueId
      ? [{ kind: 'venues', id: result.venueId, name: result.venue || '' }]
      : []),
    ...(result.publicationId
      ? [
          {
            kind: 'publications',
            id: result.publicationId,
            name: result.publication || '',
          },
        ]
      : []),
    ...(result.volumeId
      ? [{ kind: 'volumes', id: result.volumeId, name: result.volume || '' }]
      : []),
    ...collections.map((x) => ({
      kind: 'collections',
      id: x.id,
      name: x.name,
    })),
  ].filter((x) => x.id > 0);
  return result;
}
import { performanceSample } from './performance-metrics';
const cache = new Map<string, { until: number; data: unknown }>();
const pending = new Map<string, Promise<unknown>>();
export async function upstream<T>(path: string, ttl = 120): Promise<T> {
  // Candidate scans explicitly request fresh pages. They must not reuse a
  // cached response or another scan's request when checking upstream totals.
  if (ttl <= 0) return (await fetchUpstream(path)) as T;
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) {
    performanceSample('upstream_cache', { hit: 1 });
    return hit.data as T;
  }
  if (hit) cache.delete(path);
  const requestKey = JSON.stringify([path, ttl]);
  const existing = pending.get(requestKey);
  if (existing) {
    performanceSample('upstream_cache', { coalesced: 1 });
    return (await existing) as T;
  }
  performanceSample('upstream_cache', { hit: 0 });
  const request = fetchUpstream(path).then((data) => {
    if (!cache.has(path) && cache.size >= 36)
      cache.delete(cache.keys().next().value!);
    cache.set(path, { until: Date.now() + ttl * 1000, data });
    return data;
  });
  pending.set(requestKey, request);
  try {
    return (await request) as T;
  } finally {
    pending.delete(requestKey);
  }
}
async function fetchUpstream(path: string): Promise<unknown> {
  const started = performance.now();
  let data = await readUpstream(path);
  performanceSample('upstream_read', {
    durationMs: performance.now() - started,
  });
  if (path.startsWith('search/')) {
    const search = data as SearchResponse;
    const f = search.facet_counts?.facet_fields || {};
    data = {
      response: search.response,
      facet_counts: {
        facet_fields: {
          teachers: (f.teachers || []).slice(0, 50),
          subcategories: (f.subcategories || []).slice(0, 40),
          series: (f.series || []).slice(0, 40),
          locations: (f.locations || []).slice(0, 60),
          collections: (f.collections || []).slice(0, 80),
          publications: (f.publications || []).slice(0, 80),
          publicationVolumes: (f.publicationVolumes || []).slice(0, 100),
        },
      },
    };
  }
  return data;
}

export class SearchReadError extends Error {
  constructor(cause: unknown) {
    super('YUTorah search read was interrupted.', { cause });
    this.name = 'SearchReadError';
  }
}

/** Retry interrupted GETs without changing the query or the total time budget. */
async function readUpstream(path: string): Promise<unknown> {
  const attempts = path.startsWith('search/') ? 3 : 1;
  const deadline = performance.now() + 18000;
  for (let attempt = 0; ; attempt++) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0)
      throw new SearchReadError(
        new DOMException('The search timed out.', 'TimeoutError'),
      );
    // Recover quickly from stalled connections while leaving the final read
    // enough time for a slow but healthy response.
    const attemptBudget =
      attempts === 1 || attempt >= 2 ? remaining : attempt === 0 ? 3000 : 5000;
    const signal = AbortSignal.timeout(Math.min(attemptBudget, remaining));
    try {
      const response = await fetch(`${ORIGIN}/api/${path}`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`YUTorah returned ${response.status}`);
        if (attempts === 1 || ![500, 502, 503, 504].includes(response.status))
          throw error;
        const header = response.headers.get('Retry-After');
        const advertisedWait = header
          ? /^\d+$/.test(header)
            ? Number(header) * 1000
            : Date.parse(header) - Date.now()
          : 0;
        const retryAfter = Number.isFinite(advertisedWait)
          ? Math.max(0, advertisedWait)
          : 0;
        if (attempt + 1 >= attempts)
          throw retryAfter > 0 ? error : new SearchReadError(error);
        const delay = Math.max(250 * 2 ** attempt, retryAfter);
        // A requested wait beyond this pass's budget must stop recovery rather
        // than cause an immediate resume that ignores Retry-After.
        if (delay >= deadline - performance.now()) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return await response.json();
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      const interrupted =
        error instanceof Error &&
        (error.name === 'TimeoutError' ||
          (error.name === 'AbortError' &&
            signal.aborted &&
            signal.reason instanceof Error &&
            signal.reason.name === 'TimeoutError') ||
          (error instanceof TypeError &&
            !!code &&
            [
              'ECONNRESET',
              'EPIPE',
              'ETIMEDOUT',
              'UND_ERR_SOCKET',
              'UND_ERR_CONNECT_TIMEOUT',
              'UND_ERR_HEADERS_TIMEOUT',
              'UND_ERR_BODY_TIMEOUT',
            ].includes(code)));
      if (!interrupted) throw error;
      if (attempt + 1 >= attempts || performance.now() >= deadline)
        throw attempts > 1 ? new SearchReadError(error) : error;
    }
  }
}
export async function getHome(): Promise<HomeData> {
  const j = await upstream<HomeResponse>('homepage/details');
  return {
    featured: j.editorsPicks.map(normalize),
    recent: j.recentlyUploaded.map(normalize),
    recentlyViewed: (j.recentlyViewed || []).map(normalize),
    daily: j.dailyShiurim.map(normalize),
    series: j.featuredSeries
      .filter((s) => s.numShiurim > 0)
      .map((s) => ({
        id: s.seriesID,
        name: s.name,
        description: plain(s.description),
        image: safeUrl(s.imageURL),
        count: s.numShiurim,
      })),
    total: j.totalShiurCount,
    hebrewDate: j.hebrewDateString,
    daf: j.timelyData?.dafStr,
    nach: j.timelyData?.nachYomiStr,
    mishna: j.timelyData?.mishnaYomiStr,
    parsha:
      j.timelyData?.parshaStr && j.timelyData.parshaStr !== 'None'
        ? j.timelyData.parshaStr
        : undefined,
    fetchedAt: new Date().toISOString(),
    campaigns: (j.slideshow || []).map((c) => ({
      id: c.id,
      name: plain(c.name),
      description: plain(c.description),
      image: safeUrl(c.imageURL),
      url: safeUrl(c.targetURL),
    })),
    editorial: (j.carousel || []).map((c) => ({
      id: c.id,
      name: plain(c.name),
      image: safeUrl(c.imageURL),
      url: safeUrl(c.targetURL),
    })),
  };
}
export type Teacher = {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  count: number;
  image: string;
};
export type Topic = {
  id: number;
  name: string;
  count: number;
  group: string;
  branch?: string;
  path?: string[];
  description?: string;
};
export type Directory = {
  teachers: Teacher[];
  series: Series[];
  topics: Topic[];
  groups: string[];
};
let directorySnapshot: { until: number; data: Directory } | undefined;
export async function getDirectory(): Promise<Directory> {
  if (directorySnapshot && directorySnapshot.until > Date.now())
    return directorySnapshot.data;
  const [teachers, series, categories] = await Promise.all([
    upstream<RawTeacher[]>('browse/teachers', 3600),
    upstream<RawSeries[]>('browse/series', 3600),
    upstream<RawCategory[]>('browse/categories', 3600),
  ]);
  const data = {
    teachers: teachers
      .filter((t) => !t.isHidden && t.shiurCount > 0)
      .map((t) => ({
        id: t.ID,
        name: plain(
          [t.title, t.firstName, t.lastName].filter(Boolean).join(' '),
        ),
        firstName: plain(t.firstName),
        lastName: plain(t.lastName),
        count: t.shiurCount,
        image: safeUrl(t.imageURL),
      }))
      .sort((a: Teacher, b: Teacher) => b.count - a.count),
    series: series
      .filter((s) => s.shiurCount > 0)
      .map((s) => ({
        id: s.ID,
        name: s.name,
        description: plain(s.description),
        image: safeUrl(s.imageURL),
        count: s.shiurCount,
      })),
    topics: categories.flatMap((c) =>
      c.subCategories
        .filter((s) => s.shiurCount > 0)
        .map((s) => ({
          id: s.ID,
          name: s.name,
          count: s.shiurCount,
          group: c.shortName || c.name,
          branch: plain(s.middleTierName),
          path: [c.shortName || c.name, plain(s.middleTierName), s.name].filter(
            Boolean,
          ),
          description: plain(s.description),
        })),
    ),
    groups: orderedTopicGroups(categories.map((c) => c.shortName || c.name)),
  };
  directorySnapshot = { until: Date.now() + 3600000, data };
  return data;
}
export function enrichShiur(shiur: Shiur, directory: Directory): Shiur {
  const index = directorySearchIndex(directory);
  const paths = (shiur.topicIds || []).map((id) => {
    const t = index.topicsById.get(id);
    return t
      ? { id, name: t.name, group: t.group, branch: t.branch }
      : shiur.topicPaths?.find((t) => t.id === id) || {
          id,
          name: '',
          group: '',
        };
  });
  const result = {
    ...shiur,
    series: shiur.series || index.seriesById.get(shiur.seriesId)?.name || '',
    topicPaths: paths,
  };
  if (paths.some((t) => t.name)) {
    result.topics = paths.filter((t) => t.name).map((t) => t.name);
    result.category = paths.find((t) => t.group)?.group || result.category;
  }
  result.facets = [
    ...(shiur.facets || []).filter(
      (f) => !['topics', 'series'].includes(f.kind),
    ),
    ...paths.map((t) => ({
      kind: 'topics',
      id: t.id,
      name: [t.group, t.branch, t.name].filter(Boolean).join(' / '),
    })),
    ...(result.seriesId
      ? [{ kind: 'series', id: result.seriesId, name: result.series }]
      : []),
  ];
  return result;
}
export type SearchPlan = {
  notesOnly?: boolean;
  notesSnapshot?: string;
  term: string;
  original: string;
  max: number;
  sort?: string;
  min?: number;
  after?: string;
  before?: string;
  phrase?: string;
  exclude?: string;
  scope?: string;
  literal?: boolean;
  resolved?: boolean;
  language: string;
  format: string;
  teacherId: number;
  teacherName: string;
  seriesId: number;
  seriesName: string;
  topicId: number;
  venueId?: number;
  collectionId?: number;
  publicationId?: number;
  volumeId?: number;
  group?: string;
  dateBasis?: 'given' | 'uploaded';
  uploadedAfter?: string;
  uploadedBefore?: string;
  entityIds?: Record<string, number[]>;
  labels: string[];
};
export function parseSearch(
  query: string,
  options: Partial<SearchPlan> = {},
  directory?: Directory,
  knownWords: readonly string[] = [],
): SearchPlan {
  const literal = options.literal === true;
  const natural = literal
    ? { term: query.trim().slice(0, 300), options: {}, labels: [] as string[] }
    : naturalSearch(query.trim().slice(0, 300), new Date(), knownWords);
  options = {
    ...(options.resolved ? {} : natural.options),
    ...Object.fromEntries(
      Object.entries(options).filter(
        ([, v]) => v !== '' && v !== 0 && v !== undefined,
      ),
    ),
  };
  let term = natural.term;
  const labels: string[] = natural.labels;
  const sort = options.sort || (term ? 'relevance' : 'new');
  const min = Number(options.min) || 0;
  const after = options.after || '';
  const before = options.before || '';
  let phrase = options.phrase?.trim() || '';
  const excluded = options.exclude?.trim().split(/\s+/).filter(Boolean) || [];
  const quoted: string[] = [];
  term = term.replace(/"([^"]+)"/g, (_, text) => {
    if (!phrase) phrase = text;
    quoted.push(text);
    return `EXACTQUOTED${quoted.length - 1}TOKEN`;
  });
  term = term.replace(/(?:^|\s)-([\p{L}\p{N}]+)/gu, (_, word) => {
    excluded.push(word);
    return ' ';
  });
  const spacing = literal
    ? { term, labels: [] }
    : interpretSpacing(
        term,
        directory ? directorySearchIndex(directory).spacing : [],
      );
  term = spacing.term;
  labels.push(...spacing.labels);
  const exclude = [...new Set(excluded)].join(' ');
  const scope = options.scope === 'title' ? 'title' : '';
  let format = options.format || '';
  if (!literal)
    term = term.replace(
      /\b(audio|video|articles?)\s+(?:shiurim|shiur|lectures?|on|about)\b/gi,
      (_, kind) => {
        if (!format && !options.resolved)
          format = /^article/i.test(kind) ? 'text' : kind.toLowerCase();
        return ' ';
      },
    );
  let max = Number(options.max) || 0;
  let language = options.language || '';
  let teacherId = options.teacherId || 0;
  let teacherName = options.teacherName || '';
  let seriesId = options.seriesId || 0;
  let seriesName = options.seriesName || '';
  if (!literal)
    term = term.replace(
      /\b(?:under|less than|up to|within)\s+(\d+)\s*(?:minutes?|mins?)(?:\s+long)?\b/gi,
      (_, n) => {
        if (!max && !options.resolved) max = Math.min(240, Number(n));
        return ' ';
      },
    );
  if (!literal)
    term = term.replace(/\bin (hebrew|english)\b/gi, (_, l) => {
      if (!language && !options.resolved)
        language = l.toLowerCase() === 'hebrew' ? 'HE' : 'EN';
      return ' ';
    });
  if (!literal)
    term = term.replace(
      /\b(\d+)[ -]minute\s+(?:shiurim|shiur|lectures?|classes?)\b/gi,
      (_, n) => {
        if (!max && !options.resolved) max = Math.min(240, Number(n));
        return ' ';
      },
    );
  if (directory && !literal) {
    const mention = teacherMention(term, directory);
    if (
      mention &&
      (options.resolved || !teacherId || teacherId === mention.teacher.id)
    ) {
      if (!options.resolved) {
        teacherId = mention.teacher.id;
        teacherName = mention.teacher.name;
      }
      const typed = term
        .slice(mention.start, mention.end)
        .replace(/^(?:by\s+)?(?:rabbi|rabi|rabby|rav|r[.'’]?)\s+/i, '');
      if (
        !options.resolved &&
        searchText(typed) !==
          searchText(
            `${mention.teacher.firstName} ${mention.teacher.lastName}`,
          ) &&
        searchText(typed) !== searchText(mention.teacher.lastName)
      )
        labels.push(`${typed} → ${teacherName}`);
      term = term.slice(0, mention.start) + ' ' + term.slice(mention.end);
    }
  }
  if (directory && (options.resolved || !seriesId) && !literal) {
    const typed = searchText(term);
    const tokens = typed.split(' ').filter(Boolean);
    const exact = directory.series.filter(
      (series) => searchText(series.name) === typed,
    );
    const candidates = exact.length
      ? exact
      : directory.series.filter((series) => {
          const name = searchText(series.name).split(' ');
          return (
            tokens.length >= 2 &&
            tokens.length === name.length &&
            tokens.every((token, i) => wordMatch(token, name[i]) >= 0.5)
          );
        });
    const found = candidates.length === 1 ? candidates[0] : undefined;
    if (found) {
      if (!options.resolved) {
        seriesId = found.id;
        seriesName = found.name;
      }
      if (!options.resolved && typed !== searchText(found.name))
        labels.push(`${term.trim()} → ${found.name}`);
      term = '';
    }
  }
  if (!literal)
    term = term
      .replace(/\b(?:shiurim|shiur|lectures?|classes)\s*(?:on|about)?\b/gi, ' ')
      .replace(/\bby\s+(?=(?:rabbi|rabi|rabby|rav|r[.'’]?)\b)/gi, ' ')
      .replace(/\b(?:rabbi|rabi|rabby|rav)\s+/gi, ' ')
      .replace(
        /^\s*(?:teach me about|what does judaism say about|learn about|on|about|by)\s+/i,
        '',
      )
      .trim();
  const phrases: Record<string, string> = {
    'ראש השנה': 'Rosh Hashana',
    'יום כיפור': 'Yom Kippur',
    'rosh hashanah': 'Rosh Hashana',
  };
  const translated = !literal && phrases[searchText(term)];
  if (translated) {
    labels.push(`${term} → ${translated}`);
    term = translated;
  }
  const interpreted = literal
    ? { term, labels: [] }
    : interpretAliases(term, knownWords);
  term = interpreted.term;
  labels.push(...interpreted.labels);
  if (!literal) labels.push(...intentLabels(term));
  term = term.replace(/EXACTQUOTED(\d+)TOKEN/g, (_, i) => quoted[Number(i)]);
  if (directory) {
    teacherName =
      teacherName ||
      directory.teachers.find((t) => t.id === teacherId)?.name ||
      '';
    seriesName =
      seriesName || directory.series.find((s) => s.id === seriesId)?.name || '';
  }
  if (min) labels.push(`At least ${min} minutes`);
  if (after) labels.push(`From ${after}`);
  if (before) labels.push(`Through ${before}`);
  if (phrase) labels.push(`Exact phrase: ${phrase}`);
  if (exclude) labels.push(`Exclude: ${exclude}`);
  if (scope) labels.push('Title only');
  if (format)
    labels.push(
      format === 'text' ? 'Articles' : format === 'video' ? 'Video' : 'Audio',
    );
  if (max) labels.push(`Under ${max} minutes`);
  if (language) labels.push(language === 'HE' ? 'Hebrew' : 'English');
  if (options.notesOnly) labels.push('Written notes available');
  if (teacherName) labels.push(teacherName);
  if (seriesName) labels.push(seriesName);
  return {
    term: term.replace(/\s+/g, ' ').trim(),
    original: query,
    notesOnly: !!options.notesOnly,
    notesSnapshot: options.notesSnapshot,
    sort,
    min,
    after,
    before,
    phrase,
    exclude,
    scope,
    literal,
    resolved: !!options.resolved,
    max,
    language,
    format,
    teacherId,
    teacherName,
    seriesId,
    seriesName,
    topicId: options.topicId || 0,
    venueId: options.venueId || 0,
    collectionId: options.collectionId || 0,
    publicationId: options.publicationId || 0,
    volumeId: options.volumeId || 0,
    group: options.group || '',
    dateBasis: options.dateBasis === 'uploaded' ? 'uploaded' : 'given',
    uploadedAfter: options.uploadedAfter || '',
    uploadedBefore: options.uploadedBefore || '',
    entityIds: options.entityIds,
    labels,
  };
}
export function matchesPlan(s: Shiur, plan: SearchPlan) {
  const text = searchText(
    plan.scope === 'title'
      ? s.title
      : [s.title, s.teacher, s.series, ...s.topics, s.description].join(' '),
  );
  const padded = ` ${text} `;
  const date = Date.parse(
    plan.dateBasis === 'uploaded' ? s.uploadedAt || '' : s.date,
  );
  return (
    (!plan.uploadedAfter ||
      Date.parse(s.uploadedAt || '') >=
        Date.parse(dateBoundary(plan.uploadedAfter, true))) &&
    (!plan.uploadedBefore ||
      Date.parse(s.uploadedAt || '') <
        Date.parse(dateBoundary(plan.uploadedBefore, true, true))) &&
    (!plan.min || s.duration >= plan.min * 60) &&
    (!plan.after ||
      date >=
        Date.parse(dateBoundary(plan.after, plan.dateBasis === 'uploaded'))) &&
    (!plan.before ||
      date <
        Date.parse(
          dateBoundary(plan.before, plan.dateBasis === 'uploaded', true),
        )) &&
    (!plan.phrase || padded.includes(` ${searchText(plan.phrase)} `)) &&
    (!plan.exclude ||
      searchText(plan.exclude)
        .split(' ')
        .filter(Boolean)
        .every((word) => !padded.includes(` ${word} `))) &&
    (!(plan.scope || plan.literal) ||
      (plan.literal
        ? searchText(plan.term)
            .split(' ')
            .filter(Boolean)
            .every((word) => padded.includes(` ${word} `))
        : matchQuery(s.title, plan.term))) &&
    (!plan.max || (s.duration > 0 && s.duration <= plan.max * 60)) &&
    (!plan.language || s.language === plan.language) &&
    (!plan.format || mediaKind(s) === plan.format)
  );
}
export function mediaKind(s: Shiur) {
  if (['pdf', 'doc', 'docx', 'text', 'article'].includes(s.format))
    return 'text';
  if (
    ['mp4', 'video', 'youtube', 'wmv', 'avi'].includes(s.format) ||
    /youtu\.?be/.test(s.audio)
  )
    return 'video';
  return 'audio';
}
export type SearchResult = {
  notesSnapshot?: string;
  items: Shiur[];
  total: number;
  nextPage: number | null;
  plan: SearchPlan;
  filtered: boolean;
  complete?: boolean;
  retryAfterMs?: number;
  expiresAt?: number;
  scanned?: number;
  sourceTotal?: number;
  related?: boolean;
  suggestion?: string;
  correction?: string;
  run?: string;
  facets: {
    teachers: { id: number; name: string; count: number }[];
    topics: { id: number; name: string; count: number }[];
    series: { id: number; name: string; count: number }[];
    venues?: { id: number; name: string; count: number }[];
    collections?: { id: number; name: string; count: number }[];
    publications?: { id: number; name: string; count: number }[];
    volumes?: { id: number; name: string; count: number }[];
  };
};
