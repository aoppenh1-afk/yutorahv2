# Shiur autocomplete

Typing at least three characters starts a title lookup after a 200 ms pause.
Teacher, topic, and series suggestions continue to appear locally from two
characters. Their existing matcher requires the full query, so `Sukkas` puts the
matching category first, while `coffee in shabbos` shows titles containing both
subjects. Connecting words are optional. With title matches available, the
dropdown reserves five rows for shiurim and shows up to three directory matches
above them. Without title matches, it retains up to eight directory matches.

Selecting a title opens the existing shiur details view. Its metadata is fetched
only after selection. Arrow keys select suggestions, Enter opens the selected
item, Escape dismisses the dropdown, and Enter with no selection runs the existing
full search. A separate button also opens all results. Query highlighting uses
the existing shared matcher, including aliases and partial words.

## Retrieval and performance

`GET /api/suggestions?q=…` searches the persistent `search_title_catalog`, which
production already uses for learned spelling candidates. It never starts a
complete search pass, requests transcripts, or downloads the archive into the
browser. Suggestions cover the titles indexed so far. New installations need to
populate that catalog with `npm run search:index`, or their usual archive import.
New and edited titles update the full-text index automatically.

SQLite/D1 uses an external-content FTS5 index with three- and four-character
prefix indexes. PostgreSQL uses a GIN index on `to_tsvector('simple',title)`.
`simple` preserves English transliterations and Hebrew rather than applying an
English stemmer. Query compilation keeps each subject required, expands existing
aliases and up to four learned spelling candidates per subject, caps expansion
at 24 alternatives per subject, and rejects more than 12 subjects. Numeric terms
remain exact. Values stay bound parameters and user-supplied query operators are
never forwarded to either full-text parser.

The database returns its highest-ranked 50 title candidates. The existing
relevance function reranks those candidates by complete subject coverage,
literal phrasing, confidence, and distance between matching words. Literal
subject spellings get an additional preference over aliases. The endpoint returns
five compact objects containing ID, title, kind, and context. This is a bounded
ranking pass over indexed titles, not a claim that every archive record is
available or that the JavaScript ranking function scores every title.

The browser caches at most 25 queries for a minute. Requests are debounced,
cancelled on edits, blur, dismissal, and unmount, and have a three-second client
deadline. Query tags prevent late responses from showing titles for old input.
The server caches at most 64 queries per database for a minute, shares identical
in-flight lookups, and caps distinct pending queries at 32. Successful responses
also allow a minute of HTTP caching. Failures are not cached and leave directory
suggestions and full search usable.

## Research

- [Algolia's debounce guidance](https://www.algolia.com/doc/ui-libraries/autocomplete/guides/debouncing-sources)
  recommends 200 ms for remote autocomplete sources. Directory matching remains
  immediate; only database title requests wait.
- [W3C's combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
  defines the input/listbox relationship, keeping focus on the input and using
  `aria-activedescendant` for keyboard selection. Selection uses stable entity
  keys so asynchronous additions cannot switch the selected item.
- [SQLite's FTS5 documentation](https://www.sqlite.org/fts5.html#external_content_tables)
  explains external-content indexes, synchronization triggers, and rebuilding
  existing content. The migration backfills once and maintains subsequent edits.
- [PostgreSQL's index guidance](https://www.postgresql.org/docs/current/textsearch-indexes.html)
  recommends GIN for full-text lookup. Its
  [query controls](https://www.postgresql.org/docs/current/textsearch-controls.html)
  support prefix terms and proximity ranking.

Live probes on October 2, 2026 found that YUTorah's mobile `/api/search/get`
ignored requested score/ID ordering and returned newest candidates. Fielded
title queries returned no records. The website `/Search/GetSearchResults`
returned HTTP 403 from this environment. The local title catalog avoids relying
on those endpoints for ranking or response time while typing.

## Database setup

For local development and Cloudflare/D1, run `npm run db:migrate:local` before
starting the app. `drizzle/0004_title_autocomplete.sql` creates the FTS5 index,
installs synchronization triggers, rebuilds existing titles, and records its
backfill checkpoint. Sites applies this append-only migration when publishing.
The legacy D1 HTTP schema helper also supports interrupted and repeated setup.

For PostgreSQL/Vercel, apply `db/search-postgres/002_autocomplete.sql` once using
the search schema's migration owner before deploying the website. It creates an
expression index over existing titles without changing title data, vocabulary,
or import hashes. The Vercel build checks that the index exists and gives the
migration path if it is missing. Website credentials retain their existing
permissions. The feature does not require a new search service or external API
key.

## Validation

`npm run test:search` includes autocomplete checks for complete title ranking,
aliases, typos, prefixes, Hebrew, exact numbers, directory priority, input bounds,
safe query compilation, cache isolation/expiry/eviction, retries, endpoint error
handling, and index backfill/edit/delete behavior. A 100,000-title SQLite fixture
also checks the query plan uses FTS5 and measures the bounded lookup. Local runs
measured about 2–3 ms for `coffee in shabbos`; this excludes HTTP latency, cold
database connections, and the browser's 200 ms debounce.

An additional in-memory PostgreSQL run using PGlite applied both SQL migrations,
verified aliases/typos/numbers and title edits, and confirmed a bitmap scan using
the GIN index with 100,010 titles. It measured about 13 ms for the coffee query
and 377 ms for the broad prefix `daily`. These are local fixture measurements,
not production latency guarantees.
