import type { SearchDatabase, SearchStatement } from './search-storage';

const notesTables =
  /\bsearch_notes?_(?:snapshots|documents|members|state|guards|fulltext)\b/i;
const libraryTables =
  /\b(?:catalog_(?:snapshots|refresh_leases|artwork)|sources_runs|search_(?:runs|hits|documents|creation_leases|cache_usage|pass_guards|title_[a-z_]+))\b/i;

/** Notes snapshots have their own transactions and can live in another project.
 * Keep each batch on one connection so a failed batch never partially commits. */
export function routeSearchStorage(
  library: SearchDatabase,
  notes: SearchDatabase,
): SearchDatabase {
  class RoutedStatement implements SearchStatement {
    constructor(
      readonly database: SearchDatabase,
      readonly statement: SearchStatement,
    ) {}
    bind(...values: unknown[]) {
      return new RoutedStatement(this.database, this.statement.bind(...values));
    }
    first<T = Record<string, unknown>>() {
      return this.statement.first<T>();
    }
    all<T = Record<string, unknown>>() {
      return this.statement.all<T>();
    }
    run() {
      return this.statement.run();
    }
  }
  return {
    dialect: library.dialect,
    prepare(sql) {
      const usesNotes = notesTables.test(sql);
      if (usesNotes && libraryTables.test(sql))
        throw new TypeError(
          'A query cannot join the library and notes databases.',
        );
      const database = usesNotes ? notes : library;
      return new RoutedStatement(database, database.prepare(sql));
    },
    async batch(statements) {
      if (!statements.length) return [];
      if (
        statements.some((statement) => !(statement instanceof RoutedStatement))
      )
        throw new TypeError('Search statement belongs to another database.');
      const routed = statements as RoutedStatement[];
      const database = routed[0].database;
      if (routed.some((statement) => statement.database !== database))
        throw new TypeError(
          'A transaction cannot span the library and notes databases.',
        );
      return database.batch(routed.map((statement) => statement.statement));
    },
  };
}
