import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
} from 'drizzle-orm/sqlite-core';
export const searchRuns = sqliteTable(
  'search_runs',
  {
    id: text('id').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    plan: text('plan').notNull(),
    total: integer('total').notNull(),
    next: integer('next').notNull().default(1),
    created: integer('created').notNull(),
    lease: integer('lease').notNull().default(0),
    scanned: integer('scanned').notNull().default(0),
  },
  (t) => [index('search_runs_fingerprint').on(t.fingerprint, t.created)],
);
export const searchHits = sqliteTable(
  'search_hits',
  {
    run: text('run')
      .notNull()
      .references(() => searchRuns.id, { onDelete: 'cascade' }),
    id: integer('id').notNull(),
    payload: text('payload').notNull(),
    documentKey: text('document_key'),
    views: real('views').notNull().default(0),
    matched: integer('matched').notNull(),
    search: text('search').notNull().default(''),
    language: text('language').notNull().default(''),
    format: text('format').notNull().default(''),
    rank: real('rank').notNull(),
    date: real('date').notNull(),
    duration: real('duration').notNull(),
    title: text('title').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.run, t.id] }),
    index('search_hits_rank').on(t.run, t.rank),
    index('search_hits_date').on(t.run, t.date),
    index('search_hits_duration').on(t.run, t.duration),
    index('search_hits_title').on(t.run, t.title),
    index('search_hits_document').on(t.documentKey),
    index('search_hits_position').on(t.run, t.position, t.id),
    index('search_hits_popular').on(t.run, t.views, t.rank, t.id),
  ],
);

export const searchTitleCatalog = sqliteTable('search_title_catalog', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  terms: text('terms').notNull(),
});
export const searchTitleTerms = sqliteTable('search_title_terms', {
  term: text('term').primaryKey(),
  words: integer('words').notNull(),
  documents: integer('documents').notNull().default(0),
});
export const searchTitleKeys = sqliteTable(
  'search_title_keys',
  {
    key: text('key').notNull(),
    term: text('term')
      .notNull()
      .references(() => searchTitleTerms.term),
  },
  (t) => [primaryKey({ columns: [t.key, t.term] })],
);
export const searchTitleCursors = sqliteTable('search_title_cursors', {
  name: text('name').primaryKey(),
  next: integer('next').notNull().default(1),
});

export const searchTitleImports = sqliteTable('search_title_imports', {
  name: text('name').primaryKey(),
  minimum: integer('minimum').notNull(),
  maximum: integer('maximum').notNull(),
  next: integer('next').notNull(),
  total: integer('total').notNull(),
  scanned: integer('scanned').notNull().default(0),
  started: integer('started').notNull(),
  completed: integer('completed').notNull().default(0),
});

export const sourcesRuns = sqliteTable(
  'sources_runs',
  {
    id: text('id').primaryKey(),
    payload: text('payload').notNull(),
    lease: integer('lease').notNull().default(0),
    expires: integer('expires').notNull(),
  },
  (t) => [index('sources_runs_expires').on(t.expires)],
);

export const searchDocuments = sqliteTable('search_documents', {
  key: text('key').primaryKey(),
  payload: text('payload').notNull(),
  created: integer('created').notNull(),
});
export const searchCreationLeases = sqliteTable('search_creation_leases', {
  fingerprint: text('fingerprint').primaryKey(),
  owner: text('owner').notNull(),
  expires: integer('expires').notNull(),
});

export const searchCacheUsage = sqliteTable('search_cache_usage', {
  name: text('name').primaryKey(),
  bytes: integer('bytes').notNull().default(0),
});
