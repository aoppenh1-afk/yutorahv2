import type { Shiur } from './yutorah';
import { searchAliases, searchTerms, searchText } from './search-matching';

export const followKinds = [
  'teacher',
  'topic',
  'series',
  'venue',
  'collection',
] as const;
export type Follow = {
  kind: (typeof followKinds)[number];
  id: number;
  name: string;
  image?: string;
  notificationsEnabled?: boolean;
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
              followKinds.includes(f.kind) &&
              Number.isSafeInteger(f.id) &&
              f.id > 0 &&
              typeof f.name === 'string' &&
              f.name.trim().length > 0,
          )
          .filter(
            (
              (counts: Record<string, number>, seen: Set<string>) =>
              (f: Follow) => {
                const key = f.kind + ':' + f.id;
                if (seen.has(key)) return false;
                seen.add(key);
                const group = f.kind === 'teacher' ? 'teachers' : 'other';
                counts[group] = (counts[group] ?? 0) + 1;
                return counts[group] <= 100;
              }
            )({}, new Set()),
          )
          .map((f) => {
            const { notificationsEnabled } = f;
            return {
              kind: f.kind,
              id: f.id,
              name: f.name.trim().slice(0, 300),
              ...(typeof f.image === 'string'
                ? { image: f.image.slice(0, 2048) }
                : {}),
              ...(f.kind === 'teacher' &&
              typeof notificationsEnabled === 'boolean'
                ? { notificationsEnabled }
                : {}),
            };
          })
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
  if (follow.kind === 'teacher')
    return (
      shiur.teacherId === follow.id ||
      !!shiur.speakers?.some((s) => s.id === follow.id)
    );
  if (follow.kind === 'series') return shiur.seriesId === follow.id;
  if (follow.kind === 'venue') return shiur.venueId === follow.id;
  if (follow.kind === 'collection')
    return !!shiur.collections?.some((c) => c.id === follow.id);
  if (shiur.topicIds?.length) return shiur.topicIds.includes(follow.id);
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
            speakers: s.speakers?.length ? s.speakers : previous.speakers,
            venueId: s.venueId || previous.venueId,
            venue: s.venue || previous.venue,
            collections: [
              ...new Map(
                [...(previous.collections || []), ...(s.collections || [])].map(
                  (c) => [c.id, c],
                ),
              ).values(),
            ],
            views: s.views ?? previous.views,
            downloads: s.downloads ?? previous.downloads,
          }
        : s,
    );
  }
  return [...unique.values()];
}
export type Recommendation = { shiur: Shiur; reason: string; score: number };
const genericGroup =
  /^(daily shiur(?:im)?|miscellaneous|general(?: shiurim)?|all(?: shiurim)?|yutorah(?: library)?)$/;
const genericTitleWords = new Set(
  'shiur shiurim lecture lectures class classes lesson lessons part parts series daily weekly introduction intro overview learning learn torah halacha halachah halachos halachot hilchos hilchot laws law rabbi rav dr teacher siman perek chapter the and for with from about into this that what when where why how your our you are can does not הלכות הלכה שיעור שיעורים חלק פרק סימן הרב'.split(
    ' ',
  ),
);
function teacherIds(shiur: Shiur) {
  return [
    ...new Set([shiur.teacherId, ...(shiur.speakers || []).map((s) => s.id)]),
  ].filter((id) => id > 0);
}
function titleSubjects(shiur: Shiur) {
  const names = new Set(
    searchTerms(
      [shiur.teacher, ...(shiur.speakers || []).map((s) => s.name)].join(' '),
    ),
  );
  return [
    ...new Set(
      searchTerms(shiur.title.slice(0, 500))
        .filter(
          (term) =>
            /\p{L}/u.test(term) &&
            term.length > 2 &&
            !genericTitleWords.has(term) &&
            !names.has(term),
        )
        .map((term) =>
          term
            .split(' ')
            .map((word) => [...searchAliases(word)].sort()[0])
            .join(' '),
        ),
    ),
  ].slice(0, 16);
}
function recommendationInterests(library: LearningContext) {
  const interests = new Map<number, { shiur: Shiur; weight: number }>();
  const add = (shiur: Shiur, weight: number) => {
    if (library.hidden.includes(shiur.id)) return;
    const previous = interests.get(shiur.id);
    if (!previous || weight > previous.weight)
      interests.set(shiur.id, { shiur, weight });
  };
  for (const [index, h] of library.history.slice(0, 32).entries()) {
    const duration = h.duration || h.shiur.duration;
    const completed = library.completed.includes(h.shiur.id);
    // A preview or accidental play should not become a new interest.
    if (
      !completed &&
      h.seconds < Math.min(60, duration > 0 ? duration * 0.1 : 60)
    )
      continue;
    const progress = completed ? 1 : Math.min(1, h.seconds / (duration || 600));
    add(h.shiur, (0.5 + progress * 0.5) / (1 + index / 12));
  }
  for (const [index, shiur] of library.saved.slice(0, 24).entries())
    add(shiur, 1 / (1 + index / 24));
  return [...interests.values()].sort((a, b) => b.weight - a.weight);
}
export function recommendationAnchor(library: LearningContext) {
  return recommendationInterests(library)[0]?.shiur;
}
/** Share the eight-source request budget between follows and learned interests. */
export function recommendationSources(library: LearningContext): Follow[] {
  const inferred = new Map<string, { follow: Follow; weight: number }>();
  const add = (
    kind: Follow['kind'],
    id: number,
    name: string,
    weight: number,
  ) => {
    if (!(id > 0)) return;
    const key = `${kind}:${id}`;
    const previous = inferred.get(key);
    inferred.set(key, {
      follow: { kind, id, name },
      weight: (previous?.weight || 0) + weight,
    });
  };
  for (const { shiur, weight } of recommendationInterests(library)) {
    for (const id of teacherIds(shiur))
      add(
        'teacher',
        id,
        shiur.speakers?.find((s) => s.id === id)?.name || shiur.teacher,
        weight,
      );
    if (sharesSpecificSeries(shiur, shiur))
      add('series', shiur.seriesId, shiur.series, weight * 0.9);
    for (const collection of shiur.collections || [])
      if (!genericGroup.test(searchText(collection.name)))
        add('collection', collection.id, collection.name, weight * 0.9);
    for (const [index, id] of (shiur.topicIds || []).entries())
      add('topic', id, shiur.topics[index] || shiur.category, weight * 0.6);
  }
  const follows = new Set(library.following.map((f) => `${f.kind}:${f.id}`));
  const interests = [...inferred.values()]
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.follow)
    .filter((f) => !follows.has(`${f.kind}:${f.id}`));
  // Reserve room for different kinds of evidence, even with a prolific teacher.
  const kinds = new Set<string>();
  const diverse = interests.filter((f) => {
    if (kinds.has(f.kind)) return false;
    kinds.add(f.kind);
    return true;
  });
  const remaining = interests.filter((f) => !diverse.includes(f));
  return [
    ...library.following.slice(0, 4),
    ...diverse,
    ...library.following.slice(4),
    ...remaining,
  ].slice(0, 8);
}
function sharesSpecificSeries(a: Shiur, b: Shiur) {
  return (
    a.seriesId > 0 &&
    a.seriesId === b.seriesId &&
    !genericGroup.test(searchText(a.series || b.series))
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
  const interests = recommendationInterests(library).map((interest) => ({
    ...interest,
    teachers: teacherIds(interest.shiur),
    subjects: titleSubjects(interest.shiur),
  }));
  const hidden = new Set(library.hidden);
  const learned = new Set(library.completed);
  for (const h of library.history)
    if (h.duration > 0 && h.seconds / h.duration >= 0.95)
      learned.add(h.shiur.id);
  const saved = new Set(library.saved.map((s) => s.id));
  const now = options.now ?? Date.now();
  const ranked: (Recommendation & { affinity: number })[] = [];
  for (const s of mergeShiurim(items)) {
    if (hidden.has(s.id) || (!options.includeCompleted && learned.has(s.id)))
      continue;
    if (options.minutes && (!s.duration || s.duration > options.minutes * 60))
      continue;
    const normalizedTopics = s.topics.map(searchText);
    const teachers = teacherIds(s);
    const subjects = titleSubjects(s);
    const followed = library.following.find((follow) =>
      followsShiur(s, follow),
    );
    if (options.followingOnly && !followed) continue;
    let score = 0;
    let reason = 'From the YUTorah library';
    if (followed) {
      score += {
        teacher: 36,
        topic: 45,
        series: 55,
        collection: 45,
        venue: 18,
      }[followed.kind];
      reason =
        followed.kind === 'teacher'
          ? 'From a teacher you follow'
          : `You follow ${followed.name}`;
    }
    let seriesWeight = 0;
    let collectionWeight = 0;
    let teacherWeight = 0;
    let topicWeight = 0;
    let titleWeight = 0;
    let series = '';
    let collection = '';
    let topic = '';
    let relatedTitle = '';
    for (const interest of interests) {
      const { shiur, weight } = interest;
      if (shiur.id === s.id) continue;
      if (sharesSpecificSeries(shiur, s)) {
        seriesWeight += weight;
        series ||= shiur.series || s.series || 'this series';
      }
      const sharedCollection = shiur.collections?.find(
        (c) =>
          c.id > 0 &&
          !genericGroup.test(searchText(c.name)) &&
          s.collections?.some(
            (other) =>
              other.id === c.id && !genericGroup.test(searchText(other.name)),
          ),
      );
      if (sharedCollection) {
        collectionWeight += weight;
        collection ||=
          sharedCollection.name ||
          s.collections?.find((c) => c.id === sharedCollection.id)?.name ||
          'this collection';
      }
      if (teachers.some((id) => interest.teachers.includes(id)))
        teacherWeight += weight;
      const sharedSubjects = subjects.filter((term) =>
        interest.subjects.includes(term),
      );
      // Two subject words, or a recognized compound, are stronger than boilerplate.
      if (
        (sharedSubjects.length >= 2 ||
          sharedSubjects.some((term) => term.includes(' '))) &&
        sharedSubjects.length /
          Math.max(1, Math.min(subjects.length, interest.subjects.length)) >=
          0.5
      ) {
        titleWeight += weight;
        relatedTitle ||= shiur.title;
      }
      const sharedId = s.topicIds?.find((id) => shiur.topicIds?.includes(id));
      // IDs distinguish topics with the same name. Fall back for legacy records.
      const sharedName = !(s.topicIds?.length && shiur.topicIds?.length)
        ? s.topics.find((_, index) =>
            shiur.topics.some(
              (name) =>
                !!normalizedTopics[index] &&
                searchText(name) === normalizedTopics[index],
            ),
          )
        : undefined;
      if (sharedId || sharedName) {
        topicWeight += weight;
        topic ||=
          sharedName ||
          s.topics[s.topicIds!.indexOf(sharedId!)] ||
          s.category ||
          'this topic';
      }
    }
    score +=
      45 * Math.min(1.5, seriesWeight) +
      35 * Math.min(1.5, collectionWeight) +
      20 * Math.min(2, teacherWeight) +
      16 * Math.min(2, topicWeight) +
      18 * Math.min(1.5, titleWeight);
    if (seriesWeight) reason = `More in ${series}`;
    else if (collectionWeight) reason = `More from ${collection}`;
    else if (!followed) {
      if (teacherWeight) reason = 'From a teacher you learn with';
      else if (topicWeight) reason = `Because you explore ${topic}`;
      else if (titleWeight) reason = `Similar to "${relatedTitle}"`;
    }
    const affinity = score;
    const age = Math.max(0, (now - (Date.parse(s.date) || 0)) / 86400000);
    score += Math.max(0, 12 - age / 7);
    if (saved.has(s.id)) score -= 8;
    ranked.push({ shiur: s, reason, score, affinity });
  }
  // Prefer teacher variety only among similarly relevant recommendations.
  ranked.sort((a, b) => b.score - a.score || b.shiur.id - a.shiur.id);
  const output: Recommendation[] = [];
  while (ranked.length) {
    const index = ranked.findIndex(
      (r) =>
        r.affinity >= ranked[0].affinity * 0.75 &&
        r.score >= ranked[0].score - 12 &&
        output.slice(-2).every((p) => p.shiur.teacherId !== r.shiur.teacherId),
    );
    const { shiur, reason, score } = ranked.splice(index < 0 ? 0 : index, 1)[0];
    output.push({ shiur, reason, score });
  }
  return options.followingOnly
    ? output.sort(
        (a, b) =>
          (Date.parse(b.shiur.uploadedAt || b.shiur.date) || 0) -
            (Date.parse(a.shiur.uploadedAt || a.shiur.date) || 0) ||
          b.shiur.id - a.shiur.id,
      )
    : output;
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
