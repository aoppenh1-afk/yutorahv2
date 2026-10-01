/** The SQL operations used by resumable library searches. */
export interface SearchStatement {
  bind(...values: unknown[]): SearchStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface SearchDatabase {
  prepare(sql: string): SearchStatement;
  batch(statements: SearchStatement[]): Promise<unknown[]>;
}
