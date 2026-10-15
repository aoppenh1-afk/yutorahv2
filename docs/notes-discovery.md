# Inside the Shiur search

Implemented on `feat/notes-discovery`, based on `3d80a66`.
This branch has not migrated or deployed production services.

## Reader experience

Search has two categories, **Shiurim** and **Inside the Shiur**. Inside the
Shiur searches audio transcripts and completed generated notes together, with
one result per shiur. Results use the same desktop and mobile shiur rows as
regular search, including portraits, metadata, saving, queue actions, and playback
controls. Each row has a compact matching excerpt with its source and audio
timestamp where available. Selecting a title opens the full shiur details
panel, including its Listen action and study content, without starting audio
or jumping to a timestamp.
The explicit play controls work as they do in regular search. Users can also
choose whether to listen or read from the details panel.

All words and Exact phrase apply to both sources. Flexible audio also supports
transcript typo and partial-word matching, while written notes still match all
entered words. Notes use shared English/Hebrew normalization. Results report
how many distinct shiurim are shown, rather than adding overlapping source
counts. Audio uses the existing bounded twenty-hit endpoint. Audio-only matches
fill in their artwork, duration, and catalog metadata using the existing cached
shiur endpoint, with at most three requests in flight. Failed metadata reads
keep the match available; opening details retains its existing retry action.
Loading more shiurim appends the next notes page and merges matching audio into
those rows.

The Shiurim category retains natural queries, typo handling, teacher/topic/series
restrictions, and the other metadata filters. Its Refine panel adds **Written
notes available**. Availability applies before counts, sorting, facets, and
pagination across the complete candidate set. It reuses the metadata candidate
cache. URLs and saved searches preserve the availability filter. The combined
category uses `searchIn=inside`; existing `searchIn=notes` and `searchIn=audio`
links also open Inside the Shiur.

Inside the Shiur does not offer metadata autocomplete. Empty searches ask for
words. Each source loads independently, so a source outage keeps the other
source's results visible with an error and retry action. A missing, unfinished,
or expired first notes inventory never becomes a successful zero-result notes
search or an unfiltered metadata search.

## Storage and synchronization

TiDB remains the authoritative store for compressed notes. An operator copies
verified public note text and shiur metadata into the existing search database.
PostgreSQL uses a GIN expression index; D1 uses FTS5. Web requests never fetch
or decompress the whole TiDB collection. They read ten indexed matches at a
time and return bounded plain-text excerpts. React renders highlights as text,
without injecting note HTML.

`notes:search:sync` scans TiDB IDs/hashes with keyset pagination. It downloads
and verifies a note body, including its SHA-256, only for a new hash. Metadata
must identify the same shiur. English/Hebrew text comes from the existing
Markdown document parser and normalizer. Unsupported oversized documents fail
the page rather than silently truncating searchable content.

Each scan creates a private inventory of immutable document versions. Durable
cursors resume after interruption. A fenced lease and transaction guard prevent
an expired or replaced worker from committing its page. One transaction makes
the finished inventory public. Refresh failures preserve the previous ready
inventory. A subsequent successful scan picks up replacements, newly published
notes, and removals. Changes that occur after their inventory page was read are
picked up by a later scan, rather than presented as real-time publication.

The default batch is ten notes, with at most three new-body/metadata reads in
flight. `--batch NUMBER` accepts 1–20. Existing hashes are checked in one query
per batch. `--follow` repeats a completed scan every fifteen minutes and retries
failed scans on the same interval. SIGINT/SIGTERM stop between bounded work and
preserve the cursor.

Search pagination pins its ready inventory. Cleanup retains the active and one
recent completed inventory, plus the in-progress scan, to bound membership
storage. It removes unreferenced document versions in batches of 100, up to
10,000 per completed synchronization. An older results page can expire after
another refresh; retry starts a new search. Inventories older than 24 hours are
unavailable even if no successor was published. Keep the synchronizer running.

Full-text filtering uses native inverted indexes. PostgreSQL ordering uses
document-local rank. D1 favors exact phrases, then shorter matching documents
and a stable ID tie-breaker. It avoids corpus-wide BM25 scores changing a
previous inventory's pagination while a successor is being indexed.

## Rollout

Apply the schema before activating this website revision. Preserve the existing
database backups and check storage headroom before copying the notes corpus.
The index adds public text, metadata, and full-text indexes to search storage;
its production size has not been measured in this branch.

For the public PostgreSQL deployment:

```sh
# SEARCH_MIGRATION_DATABASE_URL is the existing search schema-owner connection.
npm run search:schema:migrate

# Check using SEARCH_DATABASE_URL, the restricted website role.
npm run search:schema:check

# Supply a read-only TIDB_NOTES_HOST/USERNAME/PASSWORD/DATABASE connection.
# NOTES_SEARCH_DATABASE_URL is an operator connection allowed to write the new
# search_note_* and search_notes_* tables. The schema owner also works here.
npm run notes:search:sync

# Read-only preflight, then a bounded, resumable refresh:
npm run notes:search:sync -- --check
npm run notes:search:sync -- --batch 20 --max-pages 500 --max-minutes 10

# For a continuously supervised operator process:
npm run notes:search:sync -- --follow
```

The sync command accepts `SEARCH_MIGRATION_DATABASE_URL` if the dedicated writer
variable is absent. It refuses to infer a writer from `SEARCH_DATABASE_URL`.
The website role receives SELECT on the new public index tables. Its index-write
privileges are revoked by migration `006_notes_search.sql`.
No new browser credentials or model calls are needed.

The `Refresh written notes search` Actions workflow runs hourly only when the
repository variable `NOTES_SEARCH_SYNC_ENABLED` is `true`. Configure the dedicated
`NOTES_SEARCH_DATABASE_URL` writer and read-only `TIDB_NOTES_*` secrets, run its
manual read-only check, and validate a full inventory before enabling it. Each
run checkpoints after at most 1,000 pages of five notes or ten minutes. It stops
before writing another page when `NOTES_SEARCH_MAX_DATABASE_BYTES` is reached,
which defaults to 510,000,000 bytes in Actions. Verify storage allocation before
changing that repository variable. The writer can modify
only the derived notes-index tables and cannot change the schema or title data.

Excerpt text is stored losslessly as gzip/base64 with an explicit version in
its metadata envelope. The normalized full-text column remains indexed. Readers
accept both compressed and legacy plain rows, decompress only the requested
page, and enforce a 1 MiB output bound. This reduces the duplicated note text
without changing authoritative TiDB notes, matching, ranking, or pagination.

For D1, apply `drizzle/0008_notes_search.sql` through the existing Wrangler
migration workflow. The operator uses the existing server-only
`CLOUDFLARE_ACCOUNT_ID`, `SEARCH_D1_DATABASE_ID`, and `SEARCH_D1_API_TOKEN`
configuration, together with the read-only TiDB connection. Use the actual
deployment's database ID; the checked-in local config contains a placeholder.
The owner upgrade command also supports idempotent notes-table/FTS setup and
rebuild after partial installation.

Deploy after a complete inventory is available. Verify a known note phrase,
a Hebrew phrase, a paginated search, opening details without playback, and combined
metadata refinements. Then verify that a later synchronized replacement changes
the active results. Removing these discovery controls is a UI rollback; the
canonical TiDB notes and the existing reader remain independent of the index.

## Verification

```sh
TEST_DATABASE_URL=postgresql://... npm run test:notes-search
TEST_DATABASE_URL=postgresql://... npx tsx --test tests/search-schema.test.ts tests/tidb-notes.test.ts
npm run test:search
npx tsc --noEmit
npm run lint
npm run build
npm run test:notes-search:browser
npm run performance:budgets
# Run after browser checks; the build targets share intermediate outputs.
npm run build:vercel
npm run performance:budgets -- .vercel/output/static
```

Database tests use real SQLite FTS and disposable PostgreSQL schemas. They cover
exact/whole-word English/Hebrew matches, excerpts deep in a note, all-page
availability filtering, failed/restarted scans, changed hashes, source removals,
lease fencing, read-only searches, and partial D1 index installation. Browser
checks cover 320/390/1280px, highlights, stable pagination, match modes, stale
requests, source outages and retry, merged matches, audio-only and notes-only
results opening full details without autoplay, listening from those details,
legacy links, empty-query browser history, resuming an interrupted shiur search,
URL filters, and filter removal.

Inside the Shiur, saved-search/preview controls, and Downloads load on demand.
The initial Home JavaScript cap remains 300,000 gzip bytes. The all-chunk cap
remains 425,000 bytes. Shared framework and UI chunks reduce compression overhead
while keeping export, individual-chunk, and CSS caps unchanged.

The initial notes-discovery validation passed 20 database/notes checks, four
mobile-sheet checks, and 31 download/offline checks, with zero skips. The unified
Inside the Shiur interface passed 13 browser checks for matching regular-search
row layout at 320, 390, and 1280 pixels, save/queue/play actions, and listening
from details after opening either source. The shared row changes also passed
all 49 existing player regressions. Typechecking, lint, and both production
builds passed. Cloudflare measured 298,081 gzip bytes for Home JavaScript and
427,926 bytes across reading chunks. Vercel measured 298,057 and 427,876 bytes
respectively. Both builds passed every bundle budget. Desktop and mobile
screenshots use the repository's Playwright regression workflow.

Local visual review uses clearly labeled synthetic API fixtures. It does not
establish current production coverage or live corpus relevance. Production migration, source backfill, and deployment remain release
steps; no production data was changed while implementing this branch.
