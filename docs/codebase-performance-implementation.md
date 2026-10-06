# Performance audit implementation

Implemented from [the October 5 audit](./codebase-performance-audit.md), using `1ae49ab` as the comparison revision. The audit remains the historical baseline. This document records the resulting behavior, measurements, and release requirements.

## Changes and decisions

| Finding | Result |
| --- | --- |
| F01 | A persistent audio owner publishes playback state and clock updates through separate external-store subscriptions. Lists subscribe to track/control changes; the transcript subscribes to its active segment. Navigation keeps the audio element mounted. |
| F02 | Reader, Markdown, Sources, advanced search, transcript search, and library/directory screens load on demand with loading/error boundaries. Explicit navigation hover/focus can preload secondary screens. Shared buttons, filters, and Sources polling no longer import entire screens. |
| F03 | Ordinary progress remains in memory and flushes after 25 seconds. Pause, seek, stop, track changes, preferences, pagehide, and backgrounding flush immediately. Version 2 storage stores recording metadata once; version 1 is still readable. Storage events and a read before interactive writes merge other tabs' edits and the latest progress. |
| F04 | Citation spans are indexed and sorted once per Sources result. Highlight overlap policy, character offsets, Hebrew text, cross-segment spans, and transcript identity guards are preserved. |
| F05 | Collections render 60 rows per page; transcripts render 100 segments. Paging moves keyboard focus, and playback can follow the active transcript page. Complete text remains available through a public plain-text route and full download. History and learned lookups use maps/sets. |
| F06 | Collection text and spacing vocabularies are prepared when data changes; query work is shared across candidates. Deferred filters preserve input priority. Directory suggestions reuse immutable directory data, and relevance is scored once per item/query. Existing multilingual intent and spacing behavior passes the regression corpus. |
| F07 | Initial Home feed loading uses at most eight sources and one batch. Following explicitly loads the remaining sources, reusing completed batches in a bounded cache. Trending loads when selected. Initial recommendations use Home, the bounded feed, history, and related results; Trending is no longer an implicit recommendation input. |
| F08 | Optional browser CSS rule coverage and a 50,000-byte gzip budget were added. The measured coverage is partial, so stylesheet layering is retained. Consolidation requires a broader state/media-query review; unused rules in one fixture are not established dead code. |
| F09 | Responsive rows share one media-query subscription. Only the relevant mobile/desktop Home subtree renders; mobile avoids a hidden desktop search box. |
| F10 | The verified original Lebowitz portrait has 320/640/960-pixel derivatives and responsive image selection. Original colors, framing, and fallback behavior are preserved. |
| F11 | Shared links and lookup by ID reuse the fresh detail response. Already-held list recordings can still refresh detail data. |
| B01 | Every pass receives a unique owner. The transaction locks the run, checks owner/cursor/expiry using the database clock, applies all derived writes, asserts the accepted cursor, and removes its guard. A failed assertion rolls back everything. Local progress advances only after successful commit; stale-owner cleanup is also fenced. Title import/refresh batches assert their cursor in the same transaction. |
| B02 | Publication acknowledgement and a durable Sources preparation job commit together. A separate bounded lane claims jobs, releases its SQL connection before network preparation, and retries across restarts. Preparation requests carry transcript/version identity. Publication continues while Sources is slow or unavailable. |
| B03 | PostgreSQL commits use groups of up to 120 documents/hits; D1 keeps its smaller parameter-safe groups. Transaction samples record statement count, pool wait, lock wait, and duration. Title frequency updates, hit uniqueness, cache capacity, and pass fencing remain transactional. |
| B04 | Content, status, and search share a FIFO admission bound, beyond per-key coalescing. Deployed PostgreSQL readers allow four active and 16 queued reads with an eight-second queue deadline. Overload returns 503 with Retry-After. Canceling the last subscriber removes queued work; active underlying work retains its permit until it settles. |
| B05 | Obsolete archive indexes drain in bounded batches with a two-second/ten-batch default pass and repeat scheduling while pending. Acknowledged PostgreSQL retention repeats every 30 seconds while eligible jobs remain. Counts and oldest eligible age are reported. Immutable transcript bodies, active versions, the seven-day recovery window, unpublished work, and repair checkpoints remain protected. |
| B06 | Verified immutable version metadata permits a cold matching conditional read to return 304 without body chunk reads. Authentication, existence, version, and fresh-read semantics precede the shortcut. Historical versions without verified metadata retain the full-read fallback. |
| B07 | Vercel's D1 HTTP fallback adapter is reused while account/database/token configuration is stable and invalidated when configuration changes. |
| B08 | Serialized admission alternates transcription and notes 1:1 while both queues have work, starting with transcription. Spare capacity serves either queue. The existing global ACP session cap, leadership, pause, and owned-process shutdown remain intact. |
| B09 | Numeric per-attempt download/inspection/preparation timing and byte metrics were added. Prepared-audio retention remains conditional on real retry cost and a disk-quota/TTL design. Accepted model checkpoints still survive retries; per-attempt scratch is still removed. |
| B10 | Recording/job enqueue uses bounded groups of at most 30 with shared profile insertion. Catalog pages use groups of 20; selection groups of ten lock and recheck target budgets/filter/enabled state. Accepted associations and cursor changes commit together, duplicate revisions do not consume quota, and wake notifications follow commits. |
| B11 | The page returns an immediate application shell. Home data loads on the client with cancellation and stable failure/timing diagnostics. Search, saved items, and shared links remain usable while Home is pending. Static SEO metadata remains; featured content now appears after hydration. |
| B12 | Aggregate cache, upstream, pass, scan, and transaction metrics were added. A durable metadata corpus remains a design candidate pending distinct-query/reuse/freshness measurements. Exhaustive search completeness/count semantics remain unchanged. |
| B13 | Generation and publication share 5,000-segment, 64,000-character-per-segment, and 8 MiB UTF-8 encoded-body limits. Transcripts and final notes are checked before completion. Permanent publication validation failures surface as publication_invalid without endless unchanged retries; repaired generations can publish. |
| O01 | Sampled frontend vitals, long tasks, view commits/rows, and library write metrics join aggregate server phase timings and publication/preparation/retention events. Metrics contain no search text, transcript text, credentials, URLs, or personal library data. |
| O02 | CI includes maintenance/control checks, large fixtures, request/DOM/write bounds, and gzip budgets on both targets. pg_trgm is provisioned once before parallel fixture files. New regressions cover stale/expired ownership, read admission, cleanup, permanent validation, durable preparation, and release compatibility. |
| O03 | Both builds compile without database access. Owner migrations are explicit, serialized, and versioned; runtime compatibility checks are read-only. Vercel runs the compatibility gate after compilation, before activating a push-triggered deployment. Existing/partial schemas, overlapping migrations, restricted roles, and an outage have disposable PostgreSQL coverage. |
| O04 | The installer copies vendor before its production lockfile install. The exact packaged runtime installs in an empty directory and imports the operator, search service, and worker. A smaller dedicated worker manifest remains a separate conditional packaging project. |
| O05 | Clean lockfile installation and the vendored glob regressions pass. Unused drizzle-kit configuration/dependencies were removed because migrations are reviewed append-only SQL. The dependency audit reports zero vulnerabilities. The local braces fork remains documented in vendor/README.md. |

Supported new library growth is 5,000 saved recordings, 1,000 queued recordings, and 100 playlists with 5,000 recordings each. Existing larger libraries remain readable and editable without silent truncation; history restores at most 200 entries. Ordinary progress sampling plus the 25-second flush permits approximately 30 seconds of resume-position loss if the browser crashes before a final flush. Disabled/full storage preserves in-memory edits and displays a storage error.

## Controlled measurements

Measurements ran on Linux with Node 24.20.0. They are fixture results and compressed artifact estimates, not production latency or p75 claims.

The comparison build used a separate archive of revision `1ae49ab`, a clean install of its own lockfile, and the same Node version. Initial Home estimates follow static browser/RSC client imports and include the default Home screen. Browser request checks independently assert that secondary implementations are absent on initial Home. Gzip is calculated per asset; real CDN encoding and cache behavior can differ.

| Cloudflare client artifacts | Before | After | Change |
| --- | ---: | ---: | ---: |
| Initial Home JavaScript | 296,352 bytes gzip | 261,633 bytes gzip | 11.7% less |
| Main application chunk | 170,894 bytes gzip | 33,409 bytes gzip | 80.5% less |
| Largest JavaScript chunk | 170,894 bytes gzip | 70,026 bytes gzip | 59.0% less |
| All JavaScript, including deferred screens | 303,616 bytes gzip | 322,928 bytes gzip | 6.4% more |
| Shared CSS | 43,483 bytes gzip | 43,512 bytes gzip | Essentially unchanged |

The application chunk reduction includes moving code into shared/deferred chunks; it is not an 80.5% reduction in total page transfer. Diagnostics, pagination/error controls, and separate module boundaries increase total JavaScript while reducing the initial load. The budgets are 300,000 initial Home JS bytes, 360,000 total JS bytes, 80,000 bytes for the largest JS chunk, 40,000 for the application chunk, and 50,000 CSS bytes, all gzip.

The Vercel output also passes these budgets: initial Home JS is 261,630 bytes gzip, total JS 322,914 bytes, CSS 43,512 bytes, largest JS chunk 70,028 bytes, and application chunk 33,403 bytes. Its standalone build passed with both database URLs pointing at an unavailable local port, verifying that compilation does not need either database.

| Fixture | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Highlight calculation: 5,000 segments, 1,000 citation spans | 790.40 ms repeated scanning | 3.16 ms indexed | Exact equivalent output; about 250 times faster for this helper |
| Six queries across 1,000 varied documents | 1,485.22 ms repeated preparation | 306.11 ms preparation once + 210.50 ms queries | About 65% less combined work, or 86% less query-stage work after preparation |
| Library encoding: 1,000 saved, 100 queued, 200 history, ten playlists | 1,399,937 bytes / 3.87 ms | 628,269 bytes / 2.45 ms | 55.1% less stored data and 36.7% less serialization time in this run |
| Expanded portrait asset | 3,308,680-byte original | 9,707 / 25,625 / 47,538 bytes by density | Even the largest derivative transfers 98.6% fewer image bytes |
| PostgreSQL data inserts for a full 120-candidate pass | Four document + 18 hit statements | One document + one hit statement | 22 to two data insert statements, excluding title learning, guards, and cursor work |

The helper figures come from `npm run performance:fixtures`, which asserts exact highlighting/matching equivalence before reporting timings. It runs a single controlled sample; CPU scheduling, vocabulary, and library shape affect results. Large-collection preparation still costs CPU when data first arrives. A web worker remains conditional on real long-task measurements.

The browser playback fixture loads 1,000 results and a 5,000-segment transcript, with 1,000 saved recordings, 100 queued recordings, 200 history entries, and ten playlists, then advances 60 playback clock updates over a simulated minute. The measured result is three application view commits and three library writes, with 60 result rows and 100 transcript segments mounted. It asserts no more than four commits or four writes. Pause verifies the final resume position. These counters cover the application view; player/active-segment updates intentionally continue. Render-to-layout-effect timing is a diagnostic proxy, not React Profiler self time.

Home request fixtures cover zero, ten, and 100 follows. Initial Home makes at most one feed request containing eight sources, with no Trending request. A 100-follow visitor previously started up to 13 feed batches; the new initial feed budget is one, a 92% reduction for that case. Following's explicit continuation visits every followed source, so completeness is preserved.

CSS coverage aggregates rule ranges used across the player/Sources fixture states and widths. The fixtures exercise 48.28% of the generated stylesheet's characters in used rules. This does not establish that the remaining rules can be deleted: directory, playlist, filter, interaction, and media states require a broader review.

## Diagnostics and remaining measurements

Frontend collection samples one percent of page loads, segmented by mobile/desktop and cold/warm navigation. For controlled checks, set sessionStorage `yutorah-performance-sample` to `1` before loading. The numeric API accepts at most 2,048 body bytes and a fixed metric whitelist; oversized streams are canceled. Reports are sent when the page is hidden or leaves, with duplicate payload suppression.

Server phase samples default to one percent; PERFORMANCE_SAMPLE_RATE accepts a rate between zero and one. Search/Home responses include Server-Timing. Always-on publication/preparation/retention events report queue lag and backlog. Audio preparation samples report download, inspection, preparation, bytes, and range counts to inform B09. Existing upstream/request caches remain bounded.

Production p75 LCP at most 2.5 seconds, INP at most 200 ms, and CLS at most 0.1 remain targets to assess after rollout. Compare cold/warm searches separately, then choose API and queue SLOs from traffic. CSS consolidation, retained audio caching, a permanent metadata index, and a smaller worker runtime require their own measured case; this release supplies instrumentation without changing those contracts speculatively.

## Release order

Schema changes must precede activation of the corresponding new services. Builds and a Git push do not perform these production migrations. Vercel's deployment command compiles and then runs the read-only search compatibility check; missing migrations stop activation and preserve the preceding deployment. The standalone build commands remain usable without database access. Implementation tests used local D1 state or disposable PostgreSQL fixtures; the subsequent production migration status is recorded below.

1. Install from the lockfile and compile the worker and both web targets. Preserve the existing reviewed backup/rollback procedures before touching a production database.
2. For PostgreSQL search, set SEARCH_MIGRATION_DATABASE_URL to the schema-owner connection and run `npm run search:schema:migrate`. The runner applies the versioned files under db/search-postgres, including 004_fencing.sql, under a migration lock. Keep SEARCH_DATABASE_URL as the restricted runtime connection and run `npm run search:schema:check` with that connection before activation. These credentials have different purposes; the runtime connection cannot be used implicitly as an owner.
3. For a D1 search deployment, first configure its actual database ID: the checked-in wrangler.search.jsonc contains a placeholder. Then apply reviewed migrations with `npx wrangler d1 migrations apply DB --remote --config wrangler.search.jsonc`, including drizzle/0007_search_fencing.sql. The current PostgreSQL search deployment does not need this alternative migration. Local development uses `npm run db:migrate:local`. The HTTP owner upgrade command supports existing deployments; initial provisioning still uses the full Wrangler migration history. Validate compatibility before activation.
4. Apply archive migrations with `npx wrangler d1 migrations apply DB --remote --config wrangler.transcript-archive.jsonc`, including 0006_verified_versions.sql, before restarting the publisher or archive Worker. Existing active verified versions are registered; older immutable versions still read through the fallback.
5. On the transcription host, install the compiled runtime with vendor and run the worker's `migrate` command using its write/owner connection. This applies db/transcription/009_source_preparation.sql before the upgraded publisher acknowledges work. Keep website readers restricted to content tables. Preserve credentials and existing database state when upgrading an installed operator.
6. Restart the publisher/worker/search reader and activate the compatible website/archive builds. Configure SOURCES_PREPARE_URL/TOKEN if preparation is enabled; unprepared durable jobs can retry after configuration returns. Verify homepage assets, typo/exhaustive searches, transcript/notes reads, conditional responses, playback, and publication/preparation/backlog metrics.

The SQL additions are backward-compatible with older services. Browser storage migrates to version 2 on a successful write; the new app reads both versions, but old browser code cannot interpret version 2 directly. Avoid rolling back to legacy library code after users have migrated without a compatible storage reader. Do not clear personal storage as a release step.

### Production migration status — October 5, 2026 (America/New_York)

The PostgreSQL search migration was applied to the production titles database with its schema-owner connection. The versioned runner recorded all five files through 004_fencing.sql, then passed the read-only compatibility check through the restricted application role. A rolled-back smoke transaction verified that role's guard insert/update/delete permissions and rejection of invalid guards. The title catalog contained 433,732 rows before and after; a digest of the first 100 titles and their terms was unchanged. A schema-only backup and count/digest verification reports are stored in the root-only directory /var/backups/yutorah/performance-migrations-20261006-021304. This is a schema backup, not a current full-data backup.

The transcription database refused the owner connection with PostgreSQL error 53000, reflecting its existing quota restriction. Migration 009_source_preparation.sql remains unapplied. Cloudflare archive migration 0006_verified_versions.sql also remains unapplied because no authenticated Cloudflare credentials were available on this host. No publisher/operator restart or archive deployment was performed. The search compatibility gate is now ready; the other services must wait for their corresponding migrations before upgrading.

## Validation

Validation uses Node 24, Chromium, Linux FFmpeg/process tooling, and disposable PostgreSQL schemas/databases with pg_trgm. CI runs the same supported checks; passing fixtures do not establish a production performance SLO.

| Check | Result |
| --- | --- |
| Clean lockfile install, types, lint, worker build | Passed |
| Fresh PostgreSQL parallel worker suite | 128 passed, zero failed/skipped |
| Maintenance and backup protections | Two passed, zero failed/skipped |
| Matching/intent corpus and search/storage regressions | 39 corpus assertions and 53 tests passed |
| Learning/library/discovery/trending | 51 passed |
| Sources/highlight/version behavior | 33 passed |
| Upstream cache/API behavior | 21 passed |
| Transcription control | Three passed |
| Performance API privacy/body bounds | Passed |
| Browser playback/Home/lazy-load/storage/portrait/Sources fixtures | 31 passed |
| Built website + PostgreSQL + compiled ACP pipeline | Two passed |
| Cloudflare and Vercel production builds and gzip/lazy-graph budgets | Passed on both targets |
| Clean exact operator package | Production install succeeded; all three glob regressions and worker/operator/search module imports passed |
| Dependency audit | All three glob regressions passed; zero reported vulnerabilities |

The root-only installation script was not executed. The supported Linux operator fixture separately verifies both-queue fairness, the five-session cap, pause, leadership loss, and process draining. Functional test scripts and deterministic gzip/request/DOM bounds are checked in; optional CSS coverage uses `PERFORMANCE_CSS_REPORT=/tmp/yutorah-css-coverage.json npm run test:player`.
