import type { Shiur } from './yutorah';
import { searchText } from './search-discovery';

export type Follow = {
  kind: 'teacher' | 'topic' | 'series';
  id: number;
  name: string;
  image?: string;
};
export type SavedSearch = {
  id: string;
  name: string;
  query: string;
  filters: Record<string, string>;
  createdAt: string;
};
export type LearningPreferences = {
  following: Follow[];
  hidden: number[];
  completed: number[];
  savedSearches: SavedSearch[];
  dailyGoal: number;
  learningDays: Record<string, number>;
};
export const defaultLearning: LearningPreferences = {
  following: [],
  hidden: [],
  completed: [],
  savedSearches: [],
  dailyGoal: 20,
  learningDays: {},
};
export function restoreLearning(
  value: Partial<LearningPreferences>,
): LearningPreferences {
  const ids = (v: unknown) =>
    Array.isArray(v)
      ? [...new Set(v.filter((n) => Number.isSafeInteger(n) && n > 0))].slice(
          0,
          2000,
        )
      : [];
  return {
    following: Array.isArray(value.following)
      ? value.following
          .filter(
            (f) =>
              f &&
              ['teacher', 'topic', 'series'].includes(f.kind) &&
              Number.isSafeInteger(f.id) &&
              f.id > 0 &&
              typeof f.name === 'string',
          )
          .slice(0, 100)
      : [],
    hidden: ids(value.hidden),
    completed: ids(value.completed),
    savedSearches: Array.isArray(value.savedSearches)
      ? value.savedSearches
          .filter(
            (s) =>
              s &&
              typeof s.id === 'string' &&
              typeof s.name === 'string' &&
              typeof s.query === 'string' &&
              s.filters &&
              typeof s.filters === 'object' &&
              Object.values(s.filters).every((v) => typeof v === 'string'),
          )
          .slice(0, 30)
      : [],
    dailyGoal: [5, 10, 15, 20, 30, 45, 60].includes(value.dailyGoal || 0)
      ? value.dailyGoal!
      : 20,
    learningDays:
      value.learningDays && typeof value.learningDays === 'object'
        ? Object.fromEntries(
            Object.entries(value.learningDays)
              .filter(
                ([day, seconds]) =>
                  /^\d{4}-\d{2}-\d{2}$/.test(day) &&
                  Number.isFinite(seconds) &&
                  seconds >= 0,
              )
              .sort(([a], [b]) => b.localeCompare(a))
              .slice(0, 366),
          )
        : {},
  };
}
export function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function learningStats(days: Record<string, number>, now = new Date()) {
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(now);
    date.setDate(date.getDate() - 6 + i);
    return {
      key: dayKey(date),
      label: date.toLocaleDateString('en-US', { weekday: 'short' }),
      seconds: days[dayKey(date)] || 0,
    };
  });
  let streak = 0;
  const cursor = new Date(now);
  if (!(days[dayKey(cursor)] >= 60)) cursor.setDate(cursor.getDate() - 1);
  while (days[dayKey(cursor)] >= 60 && streak < 366) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return {
    week,
    streak,
    today: days[dayKey(now)] || 0,
    weekSeconds: week.reduce((sum, day) => sum + day.seconds, 0),
  };
}
export function followsShiur(shiur: Shiur, follow: Follow) {
  if (follow.kind === 'teacher') return shiur.teacherId === follow.id;
  if (follow.kind === 'series') return shiur.seriesId === follow.id;
  return [...shiur.topics, shiur.category].some(
    (name) => searchText(name) === searchText(follow.name),
  );
}
type LearningContext = LearningPreferences & {
  saved: Shiur[];
  history: { shiur: Shiur; seconds: number; duration: number }[];
};
export function isLearned(
  shiur: Shiur,
  library: Pick<LearningContext, 'completed' | 'history'>,
) {
  return (
    library.completed.includes(shiur.id) ||
    library.history.some(
      (h) =>
        h.shiur.id === shiur.id &&
        h.duration > 0 &&
        h.seconds / h.duration >= 0.95,
    )
  );
}
export function mergeShiurim(items: Shiur[]) {
  const unique = new Map<number, Shiur>();
  for (const s of items) {
    const previous = unique.get(s.id);
    unique.set(
      s.id,
      previous
        ? {
            ...previous,
            ...s,
            duration: s.duration || previous.duration,
            audio: s.audio || previous.audio,
            image: s.image || previous.image,
            date: s.date || previous.date,
            uploadedAt: s.uploadedAt || previous.uploadedAt,
            description: s.description || previous.description,
            topics: s.topics.length ? s.topics : previous.topics,
            series: s.series || previous.series,
            seriesId: s.seriesId || previous.seriesId,
            category: s.category || previous.category,
            topicIds: s.topicIds?.length ? s.topicIds : previous.topicIds,
            views: s.views ?? previous.views,
            downloads: s.downloads ?? previous.downloads,
          }
        : s,
    );
  }
  return [...unique.values()];
}
export type Recommendation = { shiur: Shiur; reason: string; score: number };
function sharesSpecificSeries(a: Shiur, b: Shiur) {
  return (
    a.seriesId > 0 &&
    a.seriesId === b.seriesId &&
    !/^(daily shiur|daily shiurim|miscellaneous|general shiurim)$/.test(
      searchText(a.series || b.series),
    )
  );
}
export function recommend(
  items: Shiur[],
  library: LearningContext,
  options: {
    followingOnly?: boolean;
    minutes?: number;
    includeCompleted?: boolean;
    now?: number;
  } = {},
): Recommendation[] {
  const recent = library.history.slice(0, 12).map((h) => h.shiur);
  const interests = [...recent, ...library.saved.slice(0, 12)];
  const seen = new Set<number>();
  const ranked: Recommendation[] = [];
  for (const s of mergeShiurim(items)) {
    if (
      seen.has(s.id) ||
      library.hidden.includes(s.id) ||
      (!options.includeCompleted && isLearned(s, library))
    )
      continue;
    seen.add(s.id);
    if (options.minutes && (!s.duration || s.duration > options.minutes * 60))
      continue;
    const followed = library.following.find((f) => followsShiur(s, f));
    if (options.followingOnly && !followed) continue;
    let score = 0;
    let reason = 'From the YUTorah library';
    if (followed) {
      score += 70;
      reason =
        followed.kind === 'teacher'
          ? 'From a teacher you follow'
          : `You follow ${followed.name}`;
    }
    const sameSeries = interests.find(
      (i) => i.id !== s.id && sharesSpecificSeries(i, s),
    );
    if (sameSeries) {
      score += 45;
      if (!followed)
        reason = `More in ${sameSeries.series || s.series || 'this series'}`;
    }
    if (interests.some((i) => i.teacherId === s.teacherId)) {
      score += 20;
      if (!followed && !sameSeries) reason = 'From a teacher you learn with';
    }
    const topic = s.topics.find((t) =>
      interests.some((i) =>
        i.topics.some((v) => searchText(v) === searchText(t)),
      ),
    );
    if (topic) {
      score += 16;
      if (!followed && !sameSeries) reason = `Because you explore ${topic}`;
    }
    const age = Math.max(
      0,
      ((options.now ?? Date.now()) - (Date.parse(s.date) || 0)) / 86400000,
    );
    score += Math.max(0, 12 - age / 7);
    if (s.duration > 0 && s.duration <= library.dailyGoal * 60) score += 5;
    if (library.saved.some((v) => v.id === s.id)) score -= 8;
    ranked.push({ shiur: s, reason, score });
  }
  // Interleave teachers so one prolific uploader cannot fill the whole feed.
  ranked.sort((a, b) => b.score - a.score || b.shiur.id - a.shiur.id);
  const output: Recommendation[] = [];
  while (ranked.length) {
    const index = ranked.findIndex((r) =>
      output.slice(-2).every((p) => p.shiur.teacherId !== r.shiur.teacherId),
    );
    output.push(ranked.splice(index < 0 ? 0 : index, 1)[0]);
  }
  return output;
}
export function relatedShiurim(
  source: Shiur,
  items: Shiur[],
  library: LearningContext,
) {
  return recommend(
    items.filter((s) => s.id !== source.id),
    library,
  )
    .map((item) => {
      const s = item.shiur;
      const series = sharesSpecificSeries(source, s);
      const topics = s.topics.filter((t) =>
        source.topics.some((v) => searchText(v) === searchText(t)),
      );
      const topicIds = (s.topicIds || []).filter((id) =>
        source.topicIds?.includes(id),
      );
      const topicCount = Math.max(topics.length, topicIds.length);
      const topicName =
        topics[0] ||
        s.topics[(s.topicIds || []).indexOf(topicIds[0])] ||
        'this topic';
      const teacher = source.teacherId > 0 && s.teacherId === source.teacherId;
      const category =
        !!source.category &&
        searchText(source.category) === searchText(s.category);
      const short =
        source.duration > 0 &&
        source.duration <= 12 * 60 &&
        s.duration > 0 &&
        s.duration <= 12 * 60;
      const score =
        (series ? 120 : 0) +
        Math.min(2, topicCount) * 45 +
        (teacher ? 30 : 0) +
        (category ? 10 : 0) +
        (short && (series || topicCount || teacher || category) ? 25 : 0);
      const reason = series
        ? `More in ${source.series || s.series || 'this series'}`
        : topicCount
          ? `More on ${topicName}${short ? ', in 12 minutes or less' : ''}`
          : teacher
            ? `More from ${source.teacher}`
            : category
              ? `More ${source.category}${short ? ', in 12 minutes or less' : ''}`
              : '';
      return { ...item, reason, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}
