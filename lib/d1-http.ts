import type { SearchDatabase, SearchStatement } from './search-storage.js';

type Query = { sql: string; params: unknown[] };
type Result = {
  success: boolean;
  results: Record<string, unknown>[];
  meta: {
    changes: number;
    rows_read?: number;
    rows_written?: number;
    size_after?: number;
  };
};

/** Access the same durable D1 SQL storage from a Node server runtime. */
export function d1HttpDatabase(config: {
  accountId: string;
  databaseId: string;
  token: string;
  onResult?: (meta: Result['meta']) => void;
  onResults?: (
    queries: Query[],
    metas: Result['meta'][],
  ) => void | Promise<void>;
  signal?: AbortSignal;
  beforeRequest?: (queries: Query[]) => void | Promise<void>;
}): SearchDatabase {
  if (
    !/^[a-f0-9]{32}$/i.test(config.accountId) ||
    !/^[a-f0-9-]{36}$/i.test(config.databaseId) ||
    !config.token
  )
    throw new Error('Search storage is not configured.');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  async function execute(queries: Query[]): Promise<Result[]> {
    if (!queries.length) return [];
    await config.beforeRequest?.(queries);
    const options = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        queries.length === 1 ? queries[0] : { batch: queries },
      ),
      signal: config.signal
        ? AbortSignal.any([config.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      cache: 'no-store' as const,
    };
    const response = await fetch(endpoint, options);
    if (!response.ok) {
      // Classify known database failures without echoing upstream text, SQL,
      // bound values, or credentials into application logs.
      const failure = (await response.json().catch(() => null)) as {
        errors?: { message?: string }[];
      } | null;
      const message = (failure?.errors ?? [])
        .map((e) => e.message ?? '')
        .join(' ');
      const category =
        /SQLITE_FULL|database or disk is full|maximum database size|database.*size.*limit/i.test(
          message,
        )
          ? 'database size limit'
          : /quota|daily.*limit|read.*limit|write.*limit/i.test(message)
            ? 'database quota limit'
            : /too many.*variables|statement.*too long|bound.*parameter.*limit/i.test(
                  message,
                )
              ? 'query size limit'
              : /foreign key constraint/i.test(message)
                ? 'foreign key constraint'
                : '';
      throw new Error(
        `Search storage request failed (${response.status}).${category ? ` ${category}.` : ''}`,
      );
    }
    const body = (await response.json()) as {
      success: boolean;
      result?: Result[];
    };
    if (
      !body.success ||
      !Array.isArray(body.result) ||
      body.result.length !== queries.length ||
      body.result.some(
        (result) =>
          !result.success ||
          !Array.isArray(result.results) ||
          !Number.isFinite(result.meta?.changes),
      )
    )
      throw new Error('Search storage returned an unsuccessful query.');
    for (const result of body.result) config.onResult?.(result.meta);
    await config.onResults?.(
      queries,
      body.result.map((result) => result.meta),
    );
    return body.result;
  }
  class Statement implements SearchStatement {
    constructor(readonly query: Query) {}
    bind(...params: unknown[]) {
      if (
        params.some(
          (value) =>
            value !== null && !['string', 'number'].includes(typeof value),
        )
      )
        throw new TypeError('Unsupported search storage parameter.');
      return new Statement({ sql: this.query.sql, params });
    }
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      const result = await this.all<T>();
      return result.results[0] ?? null;
    }
    async all<T = Record<string, unknown>>() {
      const [result] = await execute([this.query]);
      return { ...result, results: result.results as T[] };
    }
    async run() {
      const [result] = await execute([this.query]);
      return result;
    }
  }
  return {
    prepare(sql) {
      return new Statement({ sql, params: [] });
    },
    batch(statements) {
      return execute(
        statements.map((statement) => {
          if (!(statement instanceof Statement))
            throw new TypeError(
              'Search statement belongs to another database.',
            );
          return statement.query;
        }),
      );
    },
  };
}
