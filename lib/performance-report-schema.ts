export const performanceMetrics = [
  'LCP',
  'INP',
  'CLS',
  'longTasks',
  'longTaskMs',
  'viewCommits',
  'viewCommitMs',
  'maxVisibleRows',
  'libraryWrites',
  'libraryWriteMs',
  'dataCacheHits',
  'dataCacheCoalesced',
  'dataApiCalls',
  'dataApiMs',
  'operationSamplesDropped',
] as const;
export const dataAreas = [
  'home',
  'search',
  'collection',
  'shiur',
  'catalog',
] as const;
export const dataSources = [
  'memory',
  'memory-stale',
  'server-memory',
  'snapshot',
  'refresh',
  'http-cache',
  'edge-cache',
  'network',
  'mixed',
  'unknown',
] as const;
export type DataArea = (typeof dataAreas)[number];
export type DataSource = (typeof dataSources)[number];
export const maxPerformanceBytes = 2048;
