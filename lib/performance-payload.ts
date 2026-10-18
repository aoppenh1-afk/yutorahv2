import type { DataArea, DataSource } from './performance-report-schema';
export type { DataArea, DataSource } from './performance-report-schema';

export type DataOperation = {
  area: DataArea;
  phase: 'first' | 'complete';
  ms: number;
  source: DataSource;
};
export const maxOperationSamples = 8;
export const maxOperationMs = 600_000;
