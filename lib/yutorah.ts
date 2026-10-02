import { naturalSearch } from './natural-search';
import { searchText, teacherMention } from './search-discovery';
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
  return {
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
    views:
      Number.isFinite(raw.shiurvisitsnum) && Number(raw.shiurvisitsnum) >= 0
        ? Number(raw.shiurvisitsnum)
        : undefined,
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
  };
}
const cache = new Map<string, { until: number; data: unknown }>();
export async function upstream<T>(path: string, ttl = 120): Promise<T> {
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) return hit.data as T;
  const response = await fetch(`${ORIGIN}/api/${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`YUTorah returned ${response.status}`);
  }
  let data: unknown = await response.json();
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
        },
      },
    };
  }
  if (cache.size > 35) cache.delete(cache.keys().next().value!);
  cache.set(path, { until: Date.now() + ttl * 1000, data });
  return data as T;
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
export type Topic = { id: number; name: string; count: number; group: string };
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
        })),
    ),
    groups: categories.map((c) => c.shortName || c.name),
  };
  directorySnapshot = { until: Date.now() + 3600000, data };
  return data;
}
export type SearchPlan = {
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
  language: string;
  format: string;
  teacherId: number;
  teacherName: string;
  seriesId: number;
  seriesName: string;
  topicId: number;
  labels: string[];
};
export function parseSearch(
  query: string,
  options: Partial<SearchPlan> = {},
  directory?: Directory,
): SearchPlan {
  const natural = naturalSearch(query.trim().slice(0, 300));
  options = {
    ...natural.options,
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
  const spacing = interpretSpacing(
    term,
    directory
      ? [
          ...directory.teachers.map(
            (teacher) => `${teacher.firstName} ${teacher.lastName}`,
          ),
          ...directory.topics.map((topic) => topic.name),
          ...directory.series.map((series) => series.name),
        ]
      : [],
  );
  term = spacing.term;
  labels.push(...spacing.labels);
  const exclude = [...new Set(excluded)].join(' ');
  const scope = options.scope === 'title' ? 'title' : '';
  let format = options.format || '';
  term = term.replace(
    /\b(audio|video|articles?)\s+(?:shiurim|shiur|lectures?|on|about)\b/gi,
    (_, kind) => {
      if (!format)
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
  term = term.replace(
    /\b(?:under|less than|up to|within)\s+(\d+)\s*(?:minutes?|mins?)(?:\s+long)?\b/gi,
    (_, n) => {
      if (!max) max = Math.min(240, Number(n));
      return ' ';
    },
  );
  term = term.replace(/\bin (hebrew|english)\b/gi, (_, l) => {
    if (!language) language = l.toLowerCase() === 'hebrew' ? 'HE' : 'EN';
    return ' ';
  });
  term = term.replace(
    /\b(\d+)[ -]minute\s+(?:shiurim|shiur|lectures?|classes?)\b/gi,
    (_, n) => {
      if (!max) max = Math.min(240, Number(n));
      return ' ';
    },
  );
  if (directory) {
    const mention = teacherMention(term, directory);
    if (mention && (!teacherId || teacherId === mention.teacher.id)) {
      teacherId = mention.teacher.id;
      teacherName = mention.teacher.name;
      const typed = term
        .slice(mention.start, mention.end)
        .replace(/^(?:by\s+)?(?:rabbi|rabi|rabby|rav|r[.'’]?)\s+/i, '');
      if (
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
  if (directory && !seriesId) {
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
      seriesId = found.id;
      seriesName = found.name;
      if (typed !== searchText(found.name))
        labels.push(`${term.trim()} → ${found.name}`);
      term = '';
    }
  }
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
  const translated = phrases[searchText(term)];
  if (translated) {
    labels.push(`${term} → ${translated}`);
    term = translated;
  }
  const interpreted = interpretAliases(term);
  term = interpreted.term;
  labels.push(...interpreted.labels);
  labels.push(...intentLabels(term));
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
  if (teacherName) labels.push(teacherName);
  if (seriesName) labels.push(seriesName);
  return {
    term: term.replace(/\s+/g, ' ').trim(),
    original: query,
    sort,
    min,
    after,
    before,
    phrase,
    exclude,
    scope,
    max,
    language,
    format,
    teacherId,
    teacherName,
    seriesId,
    seriesName,
    topicId: options.topicId || 0,
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
  const date = Date.parse(s.date);
  return (
    (!plan.min || s.duration >= plan.min * 60) &&
    (!plan.after || date >= Date.parse(plan.after + 'T00:00:00Z')) &&
    (!plan.before ||
      date < Date.parse(plan.before + 'T00:00:00Z') + 86400000) &&
    (!plan.phrase || padded.includes(` ${searchText(plan.phrase)} `)) &&
    (!plan.exclude ||
      searchText(plan.exclude)
        .split(' ')
        .filter(Boolean)
        .every((word) => !padded.includes(` ${word} `))) &&
    (!plan.scope || matchQuery(s.title, plan.term)) &&
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
  items: Shiur[];
  total: number;
  nextPage: number | null;
  plan: SearchPlan;
  filtered: boolean;
  complete?: boolean;
  scanned?: number;
  sourceTotal?: number;
  related?: boolean;
  run?: string;
  facets: {
    teachers: { id: number; name: string; count: number }[];
    topics: { id: number; name: string; count: number }[];
    series: { id: number; name: string; count: number }[];
  };
};
