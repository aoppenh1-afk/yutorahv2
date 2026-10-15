import type { SearchPlan } from './yutorah';

export type Filters = Record<
  | 'teacher'
  | 'series'
  | 'topic'
  | 'max'
  | 'min'
  | 'language'
  | 'format'
  | 'after'
  | 'before'
  | 'phrase'
  | 'exclude'
  | 'sort'
  | 'scope'
  | 'literal'
  | 'resolved'
  | 'venue'
  | 'collection'
  | 'publication'
  | 'volume'
  | 'group'
  | 'uploadedAfter'
  | 'uploadedBefore'
  | 'dateBasis'
  | 'notesOnly',
  string
>;
export const noFilters: Filters = {
  notesOnly: '',
  teacher: '',
  series: '',
  topic: '',
  max: '',
  min: '',
  language: '',
  format: '',
  after: '',
  before: '',
  phrase: '',
  exclude: '',
  scope: '',
  sort: '',
  literal: '',
  resolved: '',
  venue: '',
  collection: '',
  publication: '',
  volume: '',
  group: '',
  dateBasis: '',
  uploadedAfter: '',
  uploadedBefore: '',
};

export function resolvedSearchFilters(plan: SearchPlan): Filters {
  const entity = (key: string, id: number | undefined) =>
    plan.entityIds?.[key]?.join(',') || (id ? String(id) : '');
  return {
    notesOnly: plan.notesOnly ? '1' : '',
    teacher: entity('teacher', plan.teacherId),
    series: entity('series', plan.seriesId),
    topic: entity('topic', plan.topicId),
    max: plan.max ? String(plan.max) : '',
    min: plan.min ? String(plan.min) : '',
    language: plan.language,
    format: plan.format,
    after: plan.after || '',
    before: plan.before || '',
    phrase: plan.phrase || '',
    exclude: plan.exclude || '',
    scope: plan.scope || '',
    sort: plan.sort || '',
    literal: plan.literal ? '1' : '',
    resolved: '1',
    venue: entity('venue', plan.venueId),
    collection: entity('collection', plan.collectionId),
    publication: entity('publication', plan.publicationId),
    volume: entity('volume', plan.volumeId),
    group: plan.group || '',
    dateBasis: plan.dateBasis === 'uploaded' ? 'uploaded' : '',
    uploadedAfter: plan.uploadedAfter || '',
    uploadedBefore: plan.uploadedBefore || '',
  };
}

export async function copySearchLink(
  query: string,
  filters: Filters,
  notify: (text: string) => void,
) {
  const url = new URL(window.location.origin);
  url.searchParams.set('view', 'search');
  if (query) url.searchParams.set('q', query);
  Object.entries(filters).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  try {
    await navigator.clipboard.writeText(url.href);
    notify('Search link copied with all filters.');
  } catch {
    notify('Your browser could not copy the link.');
  }
}
