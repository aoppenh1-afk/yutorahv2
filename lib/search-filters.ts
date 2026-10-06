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
  | 'scope',
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
};
