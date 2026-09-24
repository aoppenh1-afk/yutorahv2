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
  ],
);
