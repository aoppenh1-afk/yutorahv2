# Codebase improvement and performance audit

- Audit date: October 5, 2026
- Repository: YU Torah
- Revision: aedc815baeddf0d70f561e72f2e631501d8dc0eb
- Verified against the same revision on October 5, 2026.
- Scope: frontend, API routes, search, Sources, transcript delivery, transcription workers, databases, deployment, and tests.

The first fixes should address search lease ownership, the publisher's dependency on Sources preparation, and the missing dependency archive in the worker installer. The strongest frontend opportunities are separating playback updates from the rest of the app, loading secondary screens on demand, and reducing repeated transcript and search calculations. These changes have clearer evidence than increasing database capacity or worker concurrency.

This report contains 29 findings and improvement candidates. Source review supports the mechanisms below, but does not establish their production cost. The verification corrected the worker-install result, narrowed the Home and detail-request claims, and removed browser timings and broad test-pass claims that were not independently rechecked. No application code, deployment, or production data was changed.

## Scope and evidence

The tracked repository contains 278 files, including 173 JavaScript and TypeScript modules and 27 SQL files. Verification focused on the implementations, callers, configuration, and tests cited by each finding. It does not establish exhaustive coverage of the repository.

The codebase-memory project is `Users-sender-Projects-YU-Torah`. Its recorded extraction generation is October 2, 2026 at 20:42:39 UTC, older than this revision. Graph lookup and call tracing provided orientation. Coverage checks included every cited source path and the application, library, and transcription scopes. Many relevant files were changed or absent from that generation, so current source supplied the evidence. The relevant partial-parse CSS and JSX ranges were checked directly. A clean coverage entry does not establish completeness.

The production build, search tests, archive/read-cache tests, dependency checks, and targeted experiments were rerun. The validation section lists these results separately from work still needed on PostgreSQL, supported Linux hosts, and deployed browsers. The original browser sample and broader test results had no retained raw logs or traces available for verification and are omitted from this verified baseline.

Evidence labels mean:

- **Reproduced:** a controlled experiment demonstrated the behavior.
- **Measured:** a build, browser run, or CPU benchmark supplied a number.
- **Code:** current source establishes the mechanism; its production cost still needs measurement.
- **Candidate:** a longer-term option whose value depends on traffic and operating constraints.

Priorities describe implementation order, not security severity. P1 means address in the next improvement pass. P2 means a concrete follow-up. P3 means conditional or longer-term work. Effort is a rough engineering estimate: small is less than a day, medium is roughly one to three days, and large needs a design and several days or more.

## Baseline measurements

### Production build

The Cloudflare production build passed again during verification. The existing local installation produced these artifacts. Sizes use decimal kB; gzip figures are estimates from compressing the files, rather than a claim about every deployment's encoding.

| Artifact | Uncompressed | Gzip |
| --- | ---: | ---: |
| Main application chunk | 546.8 kB | 170.1 kB |
| Shared stylesheet | 237.7 kB | 43.1 kB |
| Client index chunk | 193.7 kB | 54.7 kB |
| Framework chunk | 190.2 kB | 58.9 kB |
| All generated client JS and CSS | 1,218.6 kB | Not summed |

The build emitted a warning for a chunk larger than 500 kB. The total artifact size includes chunks that may load later; it is not the initial page transfer size.

### Controlled experiments

These experiments were rerun against current repository modules with temporary assertion scripts and in-memory SQLite adapters following the existing test fixtures. They verify isolated mechanisms, not end-to-end production behavior.

| Experiment | Result | Interpretation |
| --- | --- | --- |
| Change the search lease immediately before the pass commit | Response said complete with 120 scanned; stored cursor remained 1 with 0 scanned, while 120 hit rows were inserted | The pass accepts a commit after losing ownership and reports progress the database did not accept |
| Configure transcript reader maxPending to 4 and start 10 distinct blocked reads | All 10 source loads started | The limit bounds the pending map, not the execution count |
| Replace a 250-segment archived transcript with another 250-segment version | 400 index rows remained, including 150 obsolete rows | One cleanup statement leaves old index rows behind |
| Compute highlights for 5,000 segments and 1,000 citation spans across 50 sources | Current implementation median 72.57 ms; a grouped-map prototype median 0.55 ms | Indexing spans once removes repeated scans; React rendering and network time were not measured here |
| Filter 1,000 synthetic 179-word texts using matchQuery and the query teshuva | Median 224.30 ms | Repeated local matching can exceed an interactive task budget |
| Validate cleaned transcript fixtures across internal and public boundaries | 5,001 segments and a 64,001-character segment passed internal validation but failed public validation; a 10.38 MB body passed public validation but failed archive publication | Completed output can exceed publication limits |

CPU figures are medians of five runs in Node 26.9.0 on this Mac during verification. The highlight prototype was checked for equivalent output on that fixture. It is not an implemented change or an estimate of whole-app speedup. The local matching fixture repeats vocabulary and is not a representative production corpus.

## Prioritized findings

| ID | Priority | Issue | Evidence | Effort |
| --- | --- | --- | --- | --- |
| B01 | P1 | Search accepts a commit after losing its lease | Reproduced | Medium |
| B02 | P1 | Sources warm-up blocks subsequent transcript publication | Code | Medium |
| O04 | P1 | Worker installer omits the vendored dependency archive | Reproduced + code | Small |
| F01 | P1 | Playback state updates render the application tree | Code | Medium |
| F02 | P1 | Secondary screens load in the main application bundle | Measured + code | Medium |
| F03 | P2 | Playback repeatedly serializes the entire local library | Code | Medium |
| F04 | P2 | Citation highlighting scans every source for every segment | Reproduced | Small |
| F05 | P2 | Transcript and accumulated result lists render all rows | Code | Medium |
| F06 | P2 | Local search rebuilds document vocabulary during filtering | Measured + code | Medium |
| F07 | P2 | Home loads every personalized feed source before demand is known | Code | Medium |
| F08 | P3 | Shared stylesheet size warrants a usage review | Measured + candidate | Medium |
| F09 | P2 | Responsive views and listeners multiply rendering work | Code | Medium |
| F10 | P2 | Expanded player uses a 3.3 MB original portrait | Measured + code | Small |
| F11 | P3 | Opening a shiur by ID repeats its detail request | Code | Small |
| B03 | P2 | PostgreSQL pass commits use many serialized statements | Code | Medium |
| B04 | P2 | Transcript read overload has no admission bound at the cache layer | Reproduced | Small |
| B05 | P2 | One cleanup pass leaves obsolete rows; daily retention has a fixed batch limit | Reproduced + code | Medium |
| B06 | P2 | Cold conditional transcript reads assemble a body before returning 304 | Code | Small |
| B07 | P2 | Vercel's D1 fallback creates a new adapter on every access | Code | Small |
| B08 | P2 | Notes claims can starve transcription claims | Code | Medium |
| B09 | P3 | Retrying a transcription downloads and inspects its source again | Code | Medium |
| B10 | P2 | Catalog ingestion performs transactions per recording | Code | Medium |
| B11 | P2 | Initial rendering waits for the upstream homepage | Code | Medium |
| B12 | P3 | New search queries repeatedly crawl upstream candidate pages | Candidate | Large |
| B13 | P2 | Completed transcripts can exceed publication limits | Reproduced + code | Medium |
| O01 | P2 | Performance decisions lack a shared measured baseline | Code | Medium |
| O02 | P2 | CI misses maintenance/control tests; parallel fixtures create the same extension | Code | Small |
| O03 | P2 | Vercel builds include database setup and validation | Code | Medium |
| O05 | P3 | Dependency state can drift from the lockfile; development advisory remains | Reproduced + audit output | Small |

## Frontend findings

### F01. Isolate playback updates from the application tree

P1. Sources: [TorahApp](../app/torah-app.tsx#L240), [audio time updates](../lib/library.ts#L424), [row construction](../app/torah-app.tsx#L735), and [Home recommendation dependencies](../app/learning-home.tsx#L310).

The root component calls useAudio. Each audio timeupdate calls setTime in that hook, so it schedules a render of TorahApp. Row/card construction and the active view sit below that component. Frequent progress persistence also changes the whole library object, invalidating computations that depend on it. Several row actions create new closures and JSX on every render.

Move the audio element and its rapidly changing clock into a persistent player component or store. Have views subscribe only to the values they need, such as active track and playing state. Separate progress updates from saved/following preferences. Keep action callbacks stable, then memoize expensive rows and reader sections where profiling shows a benefit. React documents external store subscriptions through [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore); a smaller component with local state is also a valid solution.

Verify with a React profiler recording during 60 seconds of playback with a large result list and an open transcript. Clock ticks should update the player and any visible active progress, without rebuilding unchanged lists, Sources, or recommendations. Playback, seeking, sleep timers, and media-session controls must retain their behavior.

### F02. Load secondary screens on demand

P1. Sources: [static screen imports](../app/torah-app.tsx#L6), [transcript reader](../app/transcript-reader.tsx), and [Sources panel](../app/sources-panel.tsx).

The main application chunk is 546.8 kB before compression. TorahApp imports the advanced search, transcript search, transcript reader, and discovery UI statically. The reader also imports Sources and Markdown rendering. A visitor pays for much of this code before opening those features.

Create component boundaries for the reader, Sources, advanced search, and secondary library/directory screens. Load them on demand with module-level lazy imports and useful Suspense placeholders. Keep the player mounted across navigation. Shared exports may need to move into small modules so importing one button does not pull in a large screen. Prefetch a likely next screen after an explicit hover, focus, or idle period. React's [lazy reference](https://react.dev/reference/react/lazy) describes the loading behavior.

Inspect both deployment manifests and browser transfers after the change. An initial Home load should not download reader/Markdown or advanced-search implementation chunks. First opening each screen must work with a slow connection and a failed chunk request. Track initial compressed JavaScript separately from total application bytes.

### F03. Coalesce local library persistence

P2. Sources: [library writes](../lib/library.ts#L118), [learning-time interval](../lib/library.ts#L163), [progress saving](../lib/library.ts#L424), and [restored library collections](../lib/library.ts#L57).

Every library update synchronously calls JSON.stringify and localStorage.setItem for the complete state. Listening time updates every five seconds, and the timeupdate handler separately persists progress after roughly five seconds. During healthy playback these paths can approach two complete serializations per five seconds. The same recording metadata can appear in saved items, history, playlists, the queue, and last-played state. Saved, queue, and playlist collections lack a size bound. Progress writes cap history at 200 entries, but restoring history from storage does not apply that cap.

Separate frequently changing progress from library membership/preferences. Coalesce ordinary progress writes, for example every 15 to 30 seconds, with an immediate final flush on pause, stop, track change, and pagehide. Normalize recording metadata by ID and persist collection IDs. Define supported size limits and use IndexedDB if real libraries outgrow small synchronous storage. A storage-event or versioned merge strategy would also prevent one tab from overwriting another tab's changes.

Measure serialization time and write count for a large realistic library during a minute of playback. Check resume position after closing/reopening, backgrounding, changing speed, switching tracks, storage failure, and edits from two tabs. Choose the write interval with an explicit acceptable resume-position loss.

### F04. Index citation highlights once per Sources result

P2. Sources: [highlight lookup](../lib/source-highlights.ts#L4) and [segment rendering](../app/transcript-reader.tsx#L259).

For each segment, sourceHighlights flattens every source's occurrences and filters every span. With S segments and H citation spans, the scan costs roughly S times H before the per-segment sort. The benchmark's 5,000-segment fixture took 72.57 ms for this calculation alone.

Build a memoized map from segment index to spans when Sources or transcript identity changes. Sort and remove overlapping spans once per segment. The equivalent grouped-map prototype took 0.55 ms on the same synthetic fixture.

Keep the existing overlap policy, character offsets, reference URLs, and transcript-version guard. Add fixtures for overlapping references, multi-segment occurrences, Hebrew text, and transcript replacement. Compare outputs exactly and measure the entire reader commit, not only the helper.

### F05. Bound list and transcript DOM size

P2. Sources: [transcript segment map](../app/transcript-reader.tsx#L259), [append-on-pagination behavior](../app/torah-app.tsx#L344), [rows](../app/torah-app.tsx#L735), and [public segment limit](../packages/transcription/src/public-content.ts#L52).

The reader can render all 5,000 permitted transcript segments. Search pagination retains previously loaded results, and the shared rendering functions map the full collection. Growing DOM size increases render, layout, memory, and event-handler costs. Repeated per-row learned/progress lookups add work as collections grow. Directories already start with 36 entries, so they are not the same unbounded case.

Use accessible pagination or windowing for long results and transcripts. Precompute history and learned lookup maps rather than searching those arrays repeatedly for each row. Keep the active transcript segment visible when seeking, and provide a full-text/export route for reading, browser find, and assistive technology needs that virtualization might otherwise disrupt.

Verify 1,000 loaded results and a 5,000-segment transcript while playback continues. Measure DOM count, commit time, scrolling, and memory. Check keyboard navigation, focus retention, seek links, selection/copy, and download completeness.

### F06. Precompute local search data

P2. Sources: [matchQuery](../packages/yutorah-core/src/search-matching.ts#L593), [spacing vocabulary](../packages/yutorah-core/src/search-matching.ts#L613), [directory suggestions](../lib/search-discovery.ts#L126), [SearchBox dependencies](../app/search-box.tsx#L43), and [directory filters](../app/torah-app.tsx#L875).

matchQuery rebuilds normalized document words and up to 384 one-to-three-word phrases per candidate. Directory suggestions also rebuild entries and normalize names as the input changes. Memoizing the final filter does not help when every keystroke changes its dependency. The synthetic 1,000-document filtering pass took 224.30 ms.

Precompute normalized names, words, and bounded spacing vocabularies when directory or collection data changes. Compile reusable query work once, while preserving the candidate-specific spacing rules. Keep cached data bounded and invalidate it when text changes. Use deferred input for lower-priority result rendering, and move expensive large-collection matching into a worker if profiling still shows long tasks. [useDeferredValue](https://react.dev/reference/react/useDeferredValue) can prioritize rendering, but does not remove the calculation's CPU cost.

Retain the existing spelling/query caches. Validate the current multilingual intent corpus, quotations, exact numbers, aliases, spacing repair, teacher initials, and literal matching. Benchmark cold and warm searches using varied real-length texts, including large series descriptions.

### F07. Reduce Home request fan-out

P2. Sources: [feed loading](../app/learning-home.tsx#L195), [automatic Discover loading](../app/learning-home.tsx#L238), [related loading](../app/learning-home.tsx#L274), [feed endpoint](../app/api/feed/route.ts#L30), and [restored follow limit](../lib/learning.ts#L44).

Home starts Discover without checking the active tab, but its results also feed `allItems` and personalized recommendations. It is therefore not simply an unused Trending request. Home also loads feeds for every followed source plus up to four recent-history teachers, and loads related recordings for an anchor. With 100 restored follows, up to 104 distinct sources produce 13 sequential feed batch requests and up to 104 upstream searches on cache misses. This establishes request fan-out, not a measured first-paint delay.

Determine when Home recommendations actually need Discover data before deferring its request. A change must preserve that recommendation input or deliberately replace it. Start personalized feeds with a bounded useful sample, then load more when the relevant list needs it. Preserve completeness for a user who opens Following. Share ready responses, coalesce identical requests, and use a controlled warmer for expensive chart refreshes rather than relying on incidental page visits.

Compare network traces for an empty library, 10 follows, and 100 follows across Home, Following, and Trending. Establish a request budget for the initial viewport. Confirm that lazy loading does not silently omit follows or label incomplete charts as complete. Existing hidden-tab polling controls should remain.

### F08. Measure stylesheet usage before consolidation

P3. Sources: [layout imports](../app/layout.tsx#L3), [base styles](../app/globals.css), [redesign styles](../app/redesign.css), and [mobile styles](../app/mobile.css).

The layout imports all three stylesheets. Together they contain 11,990 authored lines, and the rebuilt stylesheet is 237.7 kB, or 43.1 kB gzip. These sizes justify a usage review. They do not identify dead rules or prove that stylesheet layering causes slow rendering. Responsive overrides can be intentional.

Measure CSS coverage across the supported views and states, then trace any apparently unused rules back to JSX and media queries. Consolidate or split styles only where that review demonstrates a useful reduction. Avoid a purge that guesses whether dynamic classes are used.

Use the existing player/Sources browser tests and visual comparisons at supported widths, including RTL text, long titles, focus states, and open sheets. Set a compressed CSS budget after consolidation. Review style recalculation time before claiming that byte reduction alone fixes interaction latency.

### F09. Share responsive state and avoid duplicate expensive views

P2. Sources: [both Home presentations](../app/learning-home.tsx#L473), [mobile hiding rules](../app/mobile.css#L104), [mobile hook](../hooks/use-mobile.ts#L5), and [row mobile hook](../app/ui.tsx#L416).

Home constructs the mobile discovery view and the desktop view, then CSS hides the inappropriate presentation. Hidden markup still incurs React construction and DOM storage. Each ShiurRow also creates its own matchMedia listener through useIsMobile. The hook starts with a desktop value and changes after mounting on a small screen.

Prefer a shared responsive component structure where possible. Use one media-query subscription for cases that need different components, or a provider with selective consumers. Avoid mounting two expensive lists solely to hide one. Preserve a stable server/hydration snapshot and reserve layout dimensions; a conditional-render rewrite that introduces a blank first paint would be a regression.

Measure both branches' render cost and listener count with a large list. Test resizing, orientation changes, SSR hydration, keyboard focus, and player persistence. A shared useSyncExternalStore subscription needs a matching server snapshot as described in [React's reference](https://react.dev/reference/react/useSyncExternalStore).

### F10. Serve display-sized player portraits

P2. Sources: [local portrait selection](../app/ui.tsx#L123), [original-photo provenance](../public/images/teachers/README.md), and [the source image](../public/images/teachers/aryeh-lebowitz.jpg).

The Lebowitz player portrait is a 5,602 by 3,735 photograph of 3,308,680 bytes. The expanded player uses that original directly. Lazy loading and async decoding already help scheduling, but do not reduce its transfer or decoded dimensions. The avatar helper also attempts an _lp suffix and falls back after an error. Its failure state belongs to each mounted portrait; the verification did not measure how often upstream upgrades fail.

Generate resized derivatives of the verified photograph at suitable widths, such as 320, 640, and 960 pixels, and provide srcset/sizes. Preserve provenance and enough resolution for high-density displays. If network traces show repeated failed portrait upgrades, use known upstream mappings or a bounded cache of failed upgrade URLs.

Compare portrait bytes, decode time, sharpness, fallback behavior, and player dimensions at one, two, and three-times pixel density. Update the portrait regression expectations to check the correct derivative and authentic source, rather than requiring the largest original file.

### F11. Reuse an already loaded detail response

P3. Sources: [openById](../app/torah-app.tsx#L439), [showDetail](../app/torah-app.tsx#L411), and [detail response caching](../app/api/shiur/route.ts#L36), and [transcript-hit opening](../app/torah-app.tsx#L662).

openById requests the shiur, then calls showDetail, which requests the same shiur again. The transcript-search handler has the same duplication only when a hit has no mediaUrl. Hits that include a media URL call showDetail directly and make one detail request. Browser and upstream caches can reduce the duplicate request's cost; two client requests do not establish two upstream downloads.

Allow showDetail to receive a known-fresh detail object, or use a shared detail loader that coalesces reads by ID. Preserve the distinction between a summary recording and a complete detail response. Carry cancellation through ID-based opening.

Verify a shared link and transcript-search hits both with and without mediaUrl each open the requested recording with one detail load. Changing recordings before the first request finishes must not reopen the older recording.

## Backend and database findings

### B01. Fence the entire search pass commit

P1. Sources: [lease acquisition](../lib/complete-search.ts#L279), [hit/document statements](../lib/complete-search.ts#L379), and [unchecked commit result](../lib/complete-search.ts#L410).

The pass claims a 30-second lease. It then reads upstream pages, ranks/hashes rows, checks title metadata, and commits multiple statements. The final cursor update checks the lease, but document and hit inserts precede that update, and the returned affected-row counts are ignored. Local cursor/scanned values advance unconditionally.

A fault injection changed ownership before the commit. The API reported a completed 120-row search, while the stored run still had next=1 and scanned=0. All 120 hits had been inserted. This reproduces an inconsistency between returned progress and accepted database progress; it does not establish that every real lease expiry corrupts results.

Give each claim a unique ownership/fencing token separate from its expiry. Verify that token, the expected cursor, and lease validity within the transaction before any pass mutation. Reject or roll back the entire commit when ownership is lost. Only update local progress after confirmed success. Renew leases during bounded work where needed, and handle expiry while waiting for a database connection or lock.

Test two database wrappers representing separate hosts. Let one owner's lease expire, let the other claim it, then release the old owner's blocked pass. The old pass must not attach hits, learn titles as part of that rejected commit, advance a cursor, or return completion. Check both D1/SQLite and PostgreSQL behavior. Apply the same affected-row discipline when reviewing import cursor commits.

### B02. Move Sources preparation off the publication path

P1. Sources: [publication loop](../packages/transcription/src/publication.ts#L78), [awaited warm-up](../packages/transcription/src/publication.ts#L136), [connection release](../packages/transcription/src/publication.ts#L153), and [preparation retry window](../apps/worker/src/source-preparation.ts#L30).

After publication is acknowledged, the publisher awaits Sources preparation before releasing its PostgreSQL client and advisory lock or moving to the next item. Preparation has a five-minute retry window, up to 120 passes, and network timeouts/waits. It can hold subsequent publications for minutes even though preparation failures do not invalidate the transcript. Sources credentials must be configured for this path to run.

Persist a separate preparation job after successful publication, then release the publication connection and lock promptly. Drain preparation jobs with bounded concurrency, retry/backoff, and deduplication by transcript identity. Use the existing durable storage and wake/backoff patterns rather than an untracked detached promise. Dependency injection would also remove the transcription package's import of an app-level preparation module.

Simulate a Sources endpoint that remains pending or unavailable. A second completed transcript must still publish promptly. Verify retries survive process restart, old-transcript preparation does not overwrite current Sources, and no PostgreSQL client stays checked out while waiting on Sefaria.

### B03. Shorten serialized PostgreSQL transactions

P2. Sources: [seven-row hit batches](../lib/complete-search.ts#L400), [document batches](../lib/complete-search.ts#L384), [transaction locks](../lib/search-postgres.ts#L160), [pool size](../lib/search-postgres.ts#L97), and [per-candidate ranking](../packages/yutorah-core/src/search-ranking.ts#L20).

A 120-candidate pass uses 18 hit INSERT statements and up to four document INSERT statements, plus title work and a cursor update. The PostgreSQL adapter executes statements sequentially. It also takes exclusive transaction-level advisory locks with keys shared across writers in the same schema for title updates and search-cache writes. These locks have a correctness purpose: shared title frequencies, capacity accounting, and orphan cleanup cannot race freely.

Use backend-specific bulk operations, such as bound JSON recordsets or UNNEST for PostgreSQL, while retaining D1-compatible chunks. Batch changed-title lookups where useful; unchanged-title learning already skips unnecessary writes. Keep transactions short and consider moving independent title learning out of the critical search commit only after defining its consistency and replay rules. A typed storage operation such as commitSearchPass would be a better boundary than extending SQL string rewrites for every optimization.

Profile ranking CPU separately from SQL. The shared ranking helper derives query terms for each candidate and calls field matching per term. Prepare query context once per pass and reuse normalized candidate fields where that preserves the existing matching rules. Validate identical scores and ordering with the current intent/ranking corpus before adopting this optimization.

Measure statement count, lock wait, pool wait, transaction duration, and p95 request latency with concurrent distinct searches. Inspect plans using [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) on disposable representative data. Keep cleanup/attachment race tests and byte accounting intact. D1's [100-parameter limit](https://developers.cloudflare.com/d1/platform/limits/) still applies to its individual statements. Increase pool size only after checking total connection capacity across application instances.

### B04. Add bounded read admission

P2. Sources: [ReadCache overflow behavior](../packages/transcription/src/read-cache.ts#L49), [cached reader construction](../packages/transcription/src/read-cache.ts#L81), and [website database pool](../lib/transcript-database.ts#L21).

When the pending map reaches maxPending, the cache calls load directly. The experiment with maxPending=4 started ten distinct source reads. The default value of 64 therefore caps tracking, not execution. A PostgreSQL pool bounds its connections, but callers can still accumulate waiting work; another reader implementation may have different limits.

Add a shared bounded semaphore or queue around source loads. Coalesce identical keys, including during overload. Bound queued work and reject excess requests with a clear retry response when appropriate. Release permits on failure, cancellation, and timeout. Coordinate per-process limits with deployment-level capacity; this audit did not inspect external WAF or platform admission settings.

Use a blocked fake source to prove that active loads never exceed the configured bound and that duplicate keys still share one load. Verify queue cancellation, recovery after an error, and stable overload responses without an unbounded waiting list.

### B05. Drain obsolete indexes and retention backlogs

P2. Sources: [archive cleanup limit](../packages/transcription/src/archive.ts#L313), [retention batch](../packages/transcription/src/retention.ts#L5), and [daily retention scheduling](../packages/transcription/src/publication.ts#L176), and [manual retention limit](../scripts/maintain-data.ts#L84).

A transcript correction performs one DELETE of at most 100 obsolete archive segment rows. Replacing 250 segments left 150 obsolete rows in the experiment. Active-version filtering protects visible results, but the old derived index still occupies storage and FTS work. Each running publisher schedules PostgreSQL retention at most once per 24 hours after a successful retention call, with a default limit of 100 eligible jobs per call. Sustained eligibility above that rate can create a backlog. Restarts and manual maintenance can add passes; the manual command uses a 1,000-job limit. No live backlog or incoming job rate was measured.

Add resumable, bounded cleanup that continues until caught up or reaches a time/write budget, then schedules its next pass. Track backlog age and count. Treat obsolete derived indexes separately from immutable published content. Preserve old content URLs according to an explicit retention policy. Preserve publication acknowledgement, the seven-day recovery window, and active-version checks in automatic retention. The separate manual inactive-transcript pruning path also requires verified backups; automatic checkpoint cleanup does not.

Test multiple corrections of a transcript larger than 100 segments. After maintenance, only intended searchable versions should remain. Test more than 100 eligible PostgreSQL jobs and confirm the backlog drains without deleting recent, active, unpublished, or retryable data. Measure D1 write allowance and storage before selecting the schedule.

### B06. Return cold 304 responses before body assembly

P2. Sources: [content read](../apps/transcript-archive/src/index.ts#L115), [late ETag check](../apps/transcript-archive/src/index.ts#L175), and [manifest expansion](../packages/transcription/src/archive.ts#L96).

On an edge cache hit, conditional requests already return 304 cheaply. On a cold cache miss, the Worker retrieves the object and reconstructs its full body before comparing If-None-Match. The archive permits bodies up to 8 MiB, so a no-body response can still incur chunk reads and allocation.

Resolve the active version or verified immutable-object metadata first. Compare the conditional header after authorization and version/existence validation, then return 304 without loading body chunks when it is valid. Keep current fresh-read semantics and headers. Avoid introducing another storage service until measurements justify it.

Use an instrumented archive database/object adapter with an empty edge cache. A matching conditional request should read the minimum metadata and zero body chunks. Test missing versions, corrected active versions, authorization, cache-hit behavior, and full reads.

### B07. Reuse the Vercel D1 HTTP adapter

P2. Sources: [Vercel DB getter](../lib/vercel-bindings.ts#L13), [complete-search WeakMap](../lib/complete-search.ts#L542), [autocomplete WeakMap](../lib/shiur-autocomplete.ts#L126), and [Sources snapshots](../lib/sources-cache.ts#L11).

With SEARCH_DATABASE_URL configured, Vercel uses the stable managed PostgreSQL adapter. In its D1 HTTP fallback, every DB getter access constructs a new adapter. Caches, pending coalescing, pruning state, and some concurrency limits keyed by adapter identity then start over for each request. Durable database leases still coordinate work, so this does not remove all protections.

Memoize the D1 adapter for a stable runtime configuration. Invalidate it when configuration changes, and keep credential values out of logs/cache diagnostics. Confirm that the Cloudflare binding and managed PostgreSQL paths retain their existing identity.

Call two endpoints repeatedly through the fallback configuration. They should share the adapter and appropriate cached/pending work. Exercise credential/configuration changes in isolated tests. This finding applies to the fallback deployment path, not every deployment.

### B08. Reserve capacity for transcription alongside notes

P2. Sources: [notes-first claim order](../apps/worker/src/worker.ts#L420) and [shared ACP concurrency](../packages/antigravity-acp/src/pool.ts#L3).

Each admission attempt claims notes before trying transcription. A continuously available notes backlog can fill every lane and keep queued recordings from starting. The global ACP session limit is a useful existing constraint; simply increasing it can consume more memory and provider quota.

Use a documented fairness policy, such as reserving a lane for transcription while both queues have work, or weighted claims with an age limit. Let spare capacity flow to either queue. Keep the shared session cap and lease protections. Check whether finishing existing notes first is an intentional product requirement before selecting weights.

Seed both queues with a sustained backlog. Measure time to first transcription start and oldest queued age for both job types. Verify mixed chunk/notes work never exceeds the ACP cap and that pause, cancellation, quota exhaustion, and leadership loss drain owned processes.

### B09. Consider a bounded prepared-audio cache for retries

P3. Sources: [per-attempt download/inspection](../apps/worker/src/worker.ts#L145), [checkpoint reuse](../packages/transcription/src/engine.ts#L54), and [scratch deletion](../apps/worker/src/worker.ts#L240).

Accepted model chunks already survive retries, which avoids retranscribing paid work. Each processJob attempt still creates new scratch space, downloads the full audio, probes it, and hashes it before deciding which chunks remain. Scratch removal is an intentional and valuable cleanup guarantee.

If retry telemetry shows material download/preparation cost, retain a verified source or prepared-chunk cache under a strict disk quota and TTL. Key it by source identity, hash, and preparation version. Revalidate source revisions and never reuse incompatible ranges/settings. Separate cache lifecycle from per-attempt scratch cleanup.

Test a failure after most chunks complete and measure bytes downloaded, preparation time, disk use, and resumed model calls. Test upstream source replacement, cache corruption, cancellation, and cleanup after restart. Keep immediate cleanup if the measured savings do not justify retaining audio.

### B10. Batch recording ingestion

P2. Sources: [selection per-record operations](../apps/worker/src/selections.ts#L286), [job enqueue](../apps/worker/src/selections.ts#L299), [target transaction](../apps/worker/src/selections.ts#L310), and [catalog enqueue loop](../apps/worker/src/catalog.ts#L79).

Selected ingestion reads target state, enqueues a recording, opens another transaction to associate the job and advance the target cursor, then repeats. Catalog ingestion also awaits enqueue for every record. The operations preserve useful idempotency and live target-budget checks, but network round trips grow with each page's recordings.

Introduce bounded bulk enqueue/association, for example small groups of 10 to 30, with shared profile insertion and target locking. Keep imported counts, recording limits, teacher filters, page offsets, and cursor changes consistent with the accepted rows. Do not hold a SQL transaction open during upstream fetches. Keep wake notifications after committed work.

Measure database queries and page-ingestion time for a full page. Test a target disabled or reconfigured during ingestion, an overlapping scan, a budget reached mid-page, duplicate recordings, and a crash between groups.

### B11. Keep the app shell responsive when the homepage upstream is slow

P2. Sources: [awaited page load](../app/page.tsx#L3), [homepage fetch](../lib/yutorah.ts#L326), and [upstream deadline](../lib/yutorah.ts#L257).

The root page awaits getHome before returning TorahApp. A cold upstream homepage request has an 18-second read budget, and the catch discards diagnostic context. The current upstream cache is useful but process-local. A slow cold homepage can delay rendering even when the visitor wants search, saved items, or a shared recording.

Render an immediate usable shell and isolate homepage data behind a streamed boundary or a bounded initial-load strategy supported by both Vinext deployment targets. Share a ready/stale homepage snapshot across instances where appropriate, and refresh it with controlled work. Preserve SEO and useful SSR content where possible. Record a stable failure event and timing without logging raw upstream payloads.

Inject a slow and unavailable upstream on a cold process. Search navigation and saved-library access should become usable within the chosen shell budget. Verify hydration, retries, stale labeling, and initial data on both Cloudflare and Vercel. No production latency or shell-readiness measurement was collected during verification.

### B12. Evaluate a durable metadata index before scaling query crawls

P3. Sources: [candidate scan passes](../lib/complete-search.ts#L289), [progress polling](../app/torah-app.tsx#L334), [title catalog](../lib/title-catalog.ts), and [search architecture](./search-architecture.md).

Completed runs are cached and identical work is coalesced. A new broad query can still require many upstream pages, normalization, ranking, hashing, and temporary hit writes. Query-specific candidates are not a durable searchable metadata corpus. Client abort stops later polling, but the running backend pass uses its own upstream timeout rather than the browser's signal.

First measure distinct-query frequency, cache reuse, candidates scanned, interrupted runs, and upstream calls per successful search. If this dominates cost, evaluate a bounded, incrementally refreshed recording metadata index with an explicit freshness policy. Another intermediate option is a durable background scan job with lightweight progress reads. Preserve exhaustive-count semantics or explicitly change the product contract. Cancellation should not abort a shared job that other callers still need.

Prototype using representative query/filter/ranking fixtures and compare freshness, completeness, storage, writes, and latency against the current design. Upstream access constraints and the database budget must be part of the decision. This is a design candidate, not a required database migration.

### B13. Align completed transcript and publication limits

P2. Sources: [internal segment validation](../packages/transcription/src/transcript.ts#L77), [completion transaction](../packages/transcription/src/store.ts#L350), [public validation](../packages/transcription/src/public-content.ts#L52), [archive size limit](../packages/transcription/src/archive.ts#L147), and [publication retry handling](../packages/transcription/src/publication.ts#L147).

Internal validation accepts up to 100,000 segments and much longer per-segment text than the public contract. The store marks a job completed after internal validation, while publication permits only 5,000 segments, 64,000 characters per segment, and an 8 MiB encoded body. A cleaned 5,001-segment fixture passed internal validation and failed public validation. A 5,000-segment fixture with a 10.38 MB serialized body passed public validation but was rejected by archive publication before storage access. These experiments checked the boundaries, not an end-to-end completed database job.

The publisher handles such errors as generic publication_failed retries with backoff capped at one hour. Retrying the same oversized content does not make it publishable. This can leave a completed recording unavailable publicly while repeatedly consuming publisher work.

Define a shared contract for supported generation and publication sizes. Validate publishability before declaring a job complete, and expose a specific operator error if output needs repair. If long recordings legitimately exceed current public limits, support bounded segment pages or another compatible archive format rather than silently truncating text. Classify permanent validation failures separately from transient storage/network failures so unchanged invalid content does not retry indefinitely. Preserve recoverable transcripts/checkpoints and allow a repaired generation to publish.

Test 5,000 versus 5,001 segments, the per-segment boundary, multibyte encoded body sizes around 8 MiB, and notes updates that increase total body size. Verify completed status, operator visibility, retry classification, recovery after repair, and complete reader/export content.

## Operations, maintainability, and verification

### O01. Record the measurements needed to choose and retain improvements

P2. Sources: [upstream reader](../lib/yutorah.ts#L257), [search adapter](../lib/search-postgres.ts#L160), [worker diagnostics](../apps/worker/src/worker.ts#L203), and [archive observability setting](../wrangler.transcript-archive.jsonc).

Worker events and archive platform observability already exist. The reviewed application modules lack a common frontend vital/commit baseline and request-phase metrics connecting upstream time, CPU work, SQL wait, and cache behavior. External dashboards were not inspected.

Add frontend LCP/INP/CLS collection and a small sampling plan for long tasks and large views. Add server timings and counters for cache hit/miss/coalescing, upstream calls, candidates scanned, SQL statements, lock/pool wait, publication lag, preparation lag, and retention backlog. Avoid recording search text, transcript content, credentials, or personal library data when aggregate identifiers/counts suffice.

Segment mobile and desktop and compare cold versus warm behavior. Suggested frontend targets are p75 LCP at most 2.5 seconds, INP at most 200 ms, and CLS at most 0.1, matching [the Core Web Vitals guidance](https://web.dev/articles/vitals). Select API and queue SLOs from measured traffic; do not combine a warm cached page and a cold exhaustive scan into one latency number.

### O02. Add missing CI checks and centralize database fixture setup

P2. Sources: [CI steps](../.github/workflows/ci.yml#L48), [maintenance command](../package.json#L35), [maintenance test](../tests/data-maintenance.test.ts#L15), [operator extension creation](../apps/worker/test/operator-pipeline.test.ts#L162), and [queue extension creation](../apps/worker/test/postgres.test.ts#L33).

CI schedules worker, search, learning, API, Sources, player, pipeline, and both web-build checks. It does not invoke test:maintenance or test:transcription-control. Worker test files independently execute CREATE EXTENSION IF NOT EXISTS pg_trgm against the same database, and the test command permits parallel files. Independent schemas do not isolate that database-global setup. Verification did not reproduce the fresh-database race, so this remains a source-supported concurrency risk.

Provision pg_trgm once in a shared disposable-database setup step before parallel suites. Add the existing maintenance and control tests to CI. Add deterministic regression coverage for B01, B04, and B05 and performance fixtures for large transcripts/results. Introduce compressed bundle/CSS budgets and request-count checks. Keep small responsiveness/timeout assertions already present.

Verify a fresh database with parallel suites repeatedly, rather than only a database where extensions already exist. Maintenance tests must use disposable schemas/databases and preserve their backup checks. Keep the Linux FFmpeg/process smoke tests in their supported environment and document local prerequisites.

### O03. Separate builds, schema validation, and migrations

P2. Sources: [Vercel build command](../package.json#L33), [schema setup script](../scripts/migrate-search-schema.ts#L119), [D1 setup branch](../scripts/migrate-search-schema.ts#L168), and [deployment selection](../vite.config.ts).

build:vercel executes the search schema script before bundling. The PostgreSQL path mostly validates owner-created tables but may attempt Sources setup; the D1 path runs idempotent migration statements. Builds can therefore depend on remote database availability and write-capable configuration. Local builds can skip setup entirely, so a passing local build does not establish deployed schema readiness.

Make the web build reproducible without database side effects. Run explicit owner migrations as a separate release step, then run a read-only schema/version compatibility check before activating the release. Keep additive rollout ordering and least-privilege application connections. Track applied versions and lock migration execution when several releases can overlap.

Exercise a clean install, a previously migrated database, a partially applied migration, a read-only runtime role, and a database outage in disposable deployment fixtures. The audit did not run the current build:vercel command against configured remote databases because it includes setup/migration operations.

### O04. Include the vendored dependency in worker installations

P1. Sources: [operator installation](../deploy/transcription/install-operator.sh#L33), [root dependency override](../package.json#L78), [lockfile](../package-lock.json), and [vendored archive](../vendor/README.md).

The installer copies package.json and package-lock.json into the installation directory, then runs npm ci --omit=dev --ignore-scripts. It does not copy vendor/yutorah-braces-3.0.4-yutorah.0.tgz, which the lockfile and override require, including for production dependencies. Reproducing that file set in an empty temporary directory failed with ENOENT for the missing archive. Omitting development dependencies does not avoid this requirement.

Include the archive at its expected relative path before installing. Verification copied vendor into the temporary installation and ran npm ci from that directory; it succeeded and added 534 packages. The three glob regressions then passed against that installation. This corrects the original report's claim that the installer file set itself installed successfully. The root-only installation commands were not executed.

An explicit worker runtime manifest or a verified production bundle could later reduce the website dependency tree included in those 534 packages. That is a separate P3 optimization. First fix the missing artifact and test the exact packaged file set in a clean directory, then run operator/search/worker smoke checks on supported Linux. Account for runtime binaries, skill contracts, migrations, and public operator files when changing packaging.

### O05. Restore reproducible dependency checks and manage remaining debt

P3. Sources: [dependency audit command](../package.json#L13), [lockfile](../package-lock.json), [vendored patch provenance](../vendor/README.md), and [glob regressions](../tests/glob-dependency.test.mjs).

The working installation had braces 3.0.3, while the lockfile specifies the vendored 3.0.4-yutorah.0 fork. All three installed-dependency glob regressions fail, so npm run audit stops before reaching npm audit. An isolated npm ci --omit=dev --ignore-scripts installation with the required vendor archive passed all three regressions during verification. This is installation drift, not evidence that the committed patch failed.

A separate lockfile-only audit reported zero high/critical entries and four moderate package entries in one dependency chain: drizzle-kit, deprecated esbuild-kit packages, and their old esbuild. The underlying advisory concerns esbuild's development server; its [maintainer advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99) identifies fixed versions. These four entries are not four distinct demonstrated production exploits.

Use clean lockfile installs for release and audit baselines. Document how to refresh a stale local installation. Review whether drizzle-kit is still needed for the active migration workflow, or update its transitive development tooling with targeted verification. Track the local braces fork and replace it when a suitable maintained upstream fix exists. Avoid accepting npm audit fix --force's suggested old drizzle-kit version without compatibility review.

Verify the glob regressions, worker build, web builds, migrations, and type checks after dependency changes. Re-run the lockfile audit and record the advisory chain actually remaining.

## Existing improvements to preserve

The October 5 implementation already includes several relevant fixes. They should not be implemented again as if absent:

- Durable creation leases, in-process coalescing, completed-result caching, candidate/byte budgets, and shared immutable search documents.
- Stored scanned counts and combined count/page work; skipping unchanged title learning.
- Batched spelling lookup and bounded caches.
- Status-only notes publication, reused timed-text/manifests, and retrying missing content chunks.
- Transcript gateway byte streaming, ETags, immutable version URLs, and reader caches.
- Ready Sources cache lookup before loading a transcript, backend citation character mapping, and bounded Sources snapshots.
- Worker/publisher idle backoff, wake notifications, operator snapshot caching, imported-count triggers, and hidden-tab polling controls.
- Seven-day acknowledged-publication retention plus maintenance dry-run, backup verification, and inactive-version safeguards.
- Global ACP concurrency, owned-process shutdown, checkpoint validation, and transcription lease fencing.

The current [implementation notes](./database-efficiency-implementation.md) document these changes. Some operational notes describe historical quota exhaustion and a pending worker migration. This audit did not inspect live production migration state, database occupancy, billing, or VM state. Confirm deployed versions before attributing a current incident to either the old behavior or the new code.

## Suggested implementation order

### First pass

Fix B01, B02, and the missing installer artifact in O04, and add their deterministic regressions. In parallel with that work, isolate player updates under F01 and establish the measurements in O01. Implement the small highlight-map change in F04. These address correctness, publication throughput, and repeated interactive work with direct evidence.

### Second pass

Split secondary bundles under F02. Bound transcript/result DOM under F05 and precompute local search data under F06. Coalesce persistence under F03. Reduce Home fan-out under F07. Add admission control under B04, stable fallback adapter identity under B07, and resumable cleanup under B05. Align publication limits under B13. Add the missing CI checks and shared extension setup under O02.

### Third pass

Measure and bulk PostgreSQL commits under B03. Add fair worker admission under B08 and bounded bulk catalog ingestion under B10. Improve initial homepage loading under B11. Reduce duplicate responsive markup, resize portraits, and remove duplicate detail loading. Use CSS coverage measurements to decide whether F08 warrants consolidation. Separate release schema steps under O03.

Use telemetry to decide whether prepared-audio caching, worker packaging, and a durable metadata index warrant the larger design cost. Each pass should produce before/after numbers and retain the relevant correctness tests.

## Validation performed during verification

Checks ran on the existing Mac installation with Node 26.9.0 and npm 11.19.1. The worker-package check used an isolated temporary directory. Database experiments used in-memory SQLite, and network reads in the search fault injection were mocked. No production database connection was used.

| Check | Result |
| --- | --- |
| npm run build | Passed; reproduced the artifact sizes above and the large-chunk warning |
| npm run test:search | Passed: 39 matching/intent tests and 51 search/storage tests |
| tsx --test apps/worker/test/transcript-archive.test.ts apps/worker/test/read-cache.test.ts | Passed: 12 tests, no skips |
| Lease, read admission, archive cleanup, and publication-limit assertions | Passed; reproduced the behaviors recorded above |
| Highlight equivalence and CPU fixtures | Exact output comparison passed on the synthetic fixture; timings recorded above |
| node --test tests/glob-dependency.test.mjs against existing node_modules | All three failed; installed braces is 3.0.3 rather than the locked fork |
| Exact installer dependency file set, package.json and package-lock.json only | Failed: missing vendor/yutorah-braces-3.0.4-yutorah.0.tgz |
| Isolated npm ci --omit=dev --ignore-scripts with vendor present | Passed: 534 packages; all three glob regressions passed |
| npm audit --package-lock-only --json | 0 high/critical, 4 moderate package entries in the esbuild development-tool chain |
| Portrait metadata and stylesheet line counts | Matched the sizes and counts cited above |

The original audit's broader test-pass table is omitted because those runs were not independently repeated. PostgreSQL contention and cleanup throughput, the fresh-database extension race, the full Linux/FFmpeg pipeline, browser network traces and React profiling, and the Vercel release/migration path remain unverified here. In particular, the SQLite lease reproduction does not replace a PostgreSQL concurrency test. Passing functional tests does not establish a performance SLO.

## Reproducing the main measurements

Use a clean disposable checkout/install with the vendor archive present for future comparisons. Run the ordinary build and listed test scripts. Type checks, lint, worker build, and the broader suites should also run before implementing or releasing the proposed changes. Use a disposable PostgreSQL database for database and maintenance tests, provision pg_trgm once before parallel test files, and run the full worker/pipeline checks on the supported Linux host.

For bundle comparisons, record every client JS/CSS artifact's byte size and compressed size, then inspect the browser network log to identify the initial requests. Do not use the sum of all chunks as the initial download.

For the targeted failures:

1. Start from the in-memory adapter in [complete-search tests](../tests/complete-search.test.mjs#L20). Before executing the batch containing the search cursor update, replace its stored lease to simulate a new owner. Compare returned complete/scanned against stored next/scanned and hit count.
2. Wrap createCachedTranscriptReader around a source that blocks on manually released promises. Set maxPending=4 and issue ten distinct content IDs. Count source loads before releasing them.
3. Use the archive SQLite fixture in [archive tests](../apps/worker/test/transcript-archive.test.ts#L22). Publish 250 segments, then 250 changed segments at a new generation. Count archive_segments rows whose version differs from the active search_version.
4. For highlight timing, build 50 sources with 20 single-span occurrences each. Give source i, occurrence j the segment index (i * 20 + j) * 5, startChar=0, endChar=5, and a source-specific ref and URL, across 5,000 segments. Compare calling sourceHighlights for every segment with a one-pass grouping map followed by the same sorting/overlap policy. Assert identical results before timing five runs.
5. For local matching timing, use 1,000 texts beginning with Lecture and a distinct numeric ID, followed by 177 words cycling through teshuva, torah, halacha, shabbat, gemara, learning, and prayer. Measure a full teshuva filtering pass over five runs. Add varied vocabulary and representative real data before setting a product budget.
6. Create cleaned fixtures with 5,000 and 5,001 short timed segments, then a fixture with one 64,001-character segment. Compare validSegments with publicContent validation. For the byte limit, use 5,000 segments containing 2,000 characters each and call TranscriptArchive.publish with storage adapters that fail on access. It should reject the roughly 10.38 MB body before accessing storage.

These experiments intentionally isolate mechanisms. Re-run the user journeys and deployment checks after implementation to determine the actual latency, throughput, and storage gains.
