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
  | 'resolved',
  string
>;
export const noFilters: Filters = {
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
};

export function resolvedSearchFilters(plan: SearchPlan): Filters {
  return {
    teacher: plan.teacherId ? String(plan.teacherId) : '',
    series: plan.seriesId ? String(plan.seriesId) : '',
    topic: plan.topicId ? String(plan.topicId) : '',
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
  };
}
