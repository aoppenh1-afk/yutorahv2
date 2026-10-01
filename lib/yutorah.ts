import { naturalSearch } from './natural-search';
import { searchText } from './search-discovery';
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
export function normalize(raw: RawShiur): Shiur {
  const teacher = raw.shiurTeachers?.[0];
  const seconds = String(raw.shiurLength ?? '0:0:0')
    .split(':')
    .reduce((s: number, n: string) => s * 60 + Number(n), 0);
  const photo =
    teacher?.teacherPhotoURL ||
    (raw.PHOTO
      ? 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/' + raw.PHOTO
      : '');
  const id = Number(raw.shiurID ?? raw.shiurid);
  return {
    id,
    title: plain(raw.shiurTitle ?? raw.shiurtitle),
    teacher: plain(teacher?.teacherName ?? raw.teacherfullname),
    teacherId: Number(teacher?.teacherID ?? raw.teacherid),
    image: safeUrl(photo),
    audio: safeUrl(raw.downloadURL || raw.shiurFileURL || raw.shiurdownloadurl),
    url: `${ORIGIN}/lectures/details?shiurID=${id}`,
    duration: raw.duration ? Number(raw.duration) * 60 : Math.round(seconds),
    date: String(raw.shiurDate ?? raw.shiurdate ?? '').replace(
      /^(\d{4}-\d{2}-\d{2}T[\d:.]+)$/,
      '$1Z',
    ),
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
  if (!response.ok) throw new Error(`YUTorah returned ${response.status}`);
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
export async function getDirectory(): Promise<Directory> {
  const [teachers, series, categories] = await Promise.all([
    upstream<RawTeacher[]>('browse/teachers', 3600),
    upstream<RawSeries[]>('browse/series', 3600),
    upstream<RawCategory[]>('browse/categories', 3600),
  ]);
  return {
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
  term = term.replace(/"([^"]+)"/g, (_, text) => {
    if (!phrase) phrase = text;
    return text;
  });
  term = term.replace(/(?:^|\s)-([\p{L}\p{N}]+)/gu, (_, word) => {
    excluded.push(word);
    return ' ';
  });
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
    const normalized = ` ${searchText(term)} `;
    const fullMatches = directory.teachers.filter(
      (t) =>
        t.firstName &&
        t.lastName &&
        normalized.includes(` ${searchText(`${t.firstName} ${t.lastName}`)} `),
    );
    let found = fullMatches.length === 1 ? fullMatches[0] : undefined;
    let surnameOnly = false;
    if (!found && !fullMatches.length) {
      const titled = term.match(/\b(?:rabbi|rav|r[.'’])\s+([\p{L}'’-]+)/iu);
      if (titled) {
        const candidates = directory.teachers.filter(
          (t) => searchText(t.lastName) === searchText(titled[1]),
        );
        if (candidates.length === 1) {
          found = candidates[0];
          surnameOnly = true;
        }
      }
    }
    if (found && (!teacherId || teacherId === found.id)) {
      teacherId = found.id;
      teacherName = found.name;
      const name = surnameOnly
        ? escapeRegex(found.lastName)
        : `${escapeRegex(found.firstName)}\\s+${escapeRegex(found.lastName)}`;
      const re = new RegExp(
        `(?:by\\s+)?(?:(?:rabbi|rav|r[.'’])\\s+)?${name}`,
        'ig',
      );
      term = term.replace(re, ' ');
    }
  }
  if (directory && !seriesId) {
    const found = directory.series.find(
      (s) => s.name.length > 5 && term.toLowerCase() === s.name.toLowerCase(),
    );
    if (found) {
      seriesId = found.id;
      seriesName = found.name;
      term = '';
    }
  }
  term = term
    .replace(/\b(?:shiurim|shiur|lectures?|classes)\s*(?:on|about)?\b/gi, ' ')
    .replace(
      /^\s*(?:teach me about|what does judaism say about|learn about|on|about|by)\s+/i,
      '',
    )
    .trim();
  const aliases: Record<string, string> = {
    repentance: 'teshuva',
    תשובה: 'teshuva',
    תפילה: 'tefillah',
    שבת: 'Shabbat',
    'ראש השנה': 'Rosh Hashana',
    'יום כיפור': 'Yom Kippur',
    sabbath: 'Shabbat',
    teshuvah: 'teshuva',
    teshuva: 'teshuva',
    'rosh hashanah': 'Rosh Hashana',
    shabbos: 'Shabbat',
    prayer: 'tefillah',
    selichos: 'selichot',
    slichot: 'selichot',
  };
  if (/^(how|what|why|can|is|does|when|where)\b/i.test(term)) {
    const subjects: [RegExp, string][] = [
      [/\b(pray|prayer|prayers|daven|davening)\b/i, 'tefillah'],
      [/\b(repent|repentance|forgive|forgiveness)\b/i, 'teshuva'],
      [/\b(faith|believe|belief)\b/i, 'emunah'],
      [/\b(character|anger|patience)\b/i, 'middot'],
      [/\b(marriage|married)\b/i, 'marriage'],
      [/\b(kosher|kashrut|kashrus)\b/i, 'kashrut'],
      [/\b(shabbat|shabbos|sabbath)\b/i, 'Shabbat'],
    ];
    const subject = subjects.find(([re]) => re.test(term));
    if (subject) {
      term = subject[1];
      labels.push(`Topic: ${term}`);
    } else {
      term = term
        .replace(
          /\b(how|what|why|can|is|does|when|where|do|i|my|the|a|an|to|me|you|your|we|our|and|of|should|could|would)\b/gi,
          ' ',
        )
        .replace(/[?]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (term) labels.push(`Keywords: ${term}`);
    }
  }
  if (aliases[term.toLowerCase()]) {
    const translated = aliases[term.toLowerCase()];
    if (translated.toLowerCase() !== term.toLowerCase())
      labels.push(`${term} → ${translated}`);
    term = translated;
  }
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
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    (!plan.scope ||
      searchText(plan.term)
        .split(' ')
        .filter(Boolean)
        .every((word) => padded.includes(` ${word} `))) &&
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
  run?: string;
  facets: {
    teachers: { id: number; name: string; count: number }[];
    topics: { id: number; name: string; count: number }[];
    series: { id: number; name: string; count: number }[];
  };
};
