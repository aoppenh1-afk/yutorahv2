import type { SearchDatabase, SearchStatement } from './search-storage';

type Query = { sql: string; params: unknown[] };
type Result = {
  success: boolean;
  results: Record<string, unknown>[];
  meta: { changes: number };
};

/** Access the same durable D1 SQL storage from a Node server runtime. */
export function d1HttpDatabase(config: {
  accountId: string;
  databaseId: string;
  token: string;
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
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        queries.length === 1 ? queries[0] : { batch: queries },
      ),
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    if (!response.ok)
      throw new Error(`Search storage request failed (${response.status}).`);
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
