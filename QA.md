# Verification record

## Scoped transcription operator and Lectern notes, 2026-09-30

- Merged current main into the transcription branch, preserving the typo/partial-word search implementation and its migration 003. Added migration 004 for bounded teacher/series selections, operator settings, and independent notes jobs.
- 58 worker checks, 24 search checks, 23 learning/discovery checks, and two compiled pipeline checks pass with Node 24.20.0, PostgreSQL 17, and FFmpeg. TypeScript, lint, shell/GUI JavaScript syntax checks, worker build, and website production build pass. The dependency audit has zero high/critical findings; four previously recorded moderate findings remain in the development-only Drizzle Kit dependency chain.
- Selection tests verify durable total budgets, overlapping-source deduplication, disabled-source ownership, teacher restrictions within series, and changing a restriction during an in-flight import without overwriting its reset cursor. An empty/paused selection set never scans the entire archive. GUI imports wait for Google sign-in and an advertised saved model.
- Live filtered imports in an isolated test schema queued two Rabbi Aryeh Lebowitz recordings and two of his Ten Minute Halacha recordings. Repeating the scan added zero jobs. The exact directory entries are teacher 80714 and series 4233; the differently spelled teacher 81310 is a separate entry. No production audio or model request was made, and the installed database was not populated by this check.
- Both Antigravity skills match Lectern commit `1b1032f96039aaac63261afc84a86cd20ce63867` byte for byte. Generation follows the inspected Swift cleanup/checkpoint/notes/normalization/validation/one-repair flow. Tests exercise independent notes leases, cancellation, retry without recleaning, the full inline skill contracts, and rejection of native tools. Real worker orchestration automatically publishes both artifacts through the ACP fixture.
- Real downloaded-audio work using synthetic WAV files verifies deletion after success, provider failure, and a partial download failure. Existing cancellation and SIGKILL recovery checks remain passing. The scheduler test finishes transcription and notes with no owned audio/runtime scratch directories left.
- The compiled website reads timestamped transcripts and completed notes from PostgreSQL through the authenticated read-only endpoint. English, Hebrew, and misspelled spoken-word queries pass through main's search. Missing content, invalid queries, and a stopped backend return the expected 404/400/503 responses, with no browser-exposed read token.
- Installed the built GUI and read-only service at `/opt/yutorah-operator` on this VM. The pinned Google Linux x86-64 runtime downloaded successfully through Google's edge mirror and passed the native ACP handshake under the actual `yutorah-worker` account. Operator HTTP/login/directory and reader HTTP/auth checks pass. Both suggested selections are saved disabled with budgets of 10; the series is restricted to teacher 80714. The queue is paused, Google is unconnected, there are zero jobs, and scratch usage is zero.
- This development VM has no systemd; installed background services use the restart instructions in [the operator guide](docs/transcription-operator.md). The collaborative preview repeatedly failed to navigate to the VM service, so this revision has HTTP/integration checks but no claimed GUI visual/browser interaction check. Google sign-in, real transcription/notes quality, account quota/renewal, ARM64 execution, and the existing website's deployed HTTPS connection remain commissioning steps. No main merge or website publication was performed.

## Media library redesign, 2026-09-30

- TypeScript, authored-source lint, and the production build pass. All 23 learning/discovery tests, 24 search checks, and nine live API tests pass. The live suite completed in about six minutes, including full candidate scans for broad queries.
- The built Cloudflare Worker runs locally on port 3002. Its homepage, home API, discovery API, and related API return successful responses. Discovery returned 180 sampled recordings with genuine view counts and no partial-data flag; the Ten Minute Halacha related endpoint returned 87 unique candidates, including 29 other recordings in that series.
- The T3 collaborative browser was used for desktop interaction and screenshots. Responsive same-origin frames exercised actual 768px, 390px, and 320px CSS viewports. Document width matched each viewport after correcting a 4px overflow at 320px. Home, saved-library, history, queue, and expanded player layouts were inspected. This is not a substitute for testing physical devices or Safari.
- A real CDN recording played and advanced normally. Pausing at 73.849541 seconds saved that exact position; a fresh page restored the same position without autoplay. The unfinished recording appeared in Continue learning, and History showed 1:13 listened.
- Keyboard seeking to the beginning saved a zero-second position; a fresh History page restored 0:00. Saved items, the note, and the playlist also survived that reload.
- Saving the recording placed it in Saved shiurim. Adding it to the queue updated the queue and badge. The expanded phone player exposed seeking in both directions, the next action, notes, speed, and queue. Selecting 1.5× set both the saved preference and the audio element's playback rate to 1.5.
- A note entered through the detail page was saved at 73 seconds and displayed as 1:13. Creating “Evening learning” from the playlist dialog added the recording. Following Morah Stacey Goldman populated the Following view with eight of her recordings.
- The live Ten Minute Halacha detail page showed five recommendations with an explicit “More in Ten Minute Halacha” reason. Numeric topics from the sparse detail API are covered by regression tests. A separate regression ensures that a generic Daily Shiur series cannot elevate unrelated topics.
- The Trending page rendered 12 recordings in descending genuine-view order and exposed working duration filters. The source text describes lifetime views within recent uploads; it does not claim a rolling global chart. Counts are not synthesized when the public API omits them.
- The final browser snapshot reported no console entries, failed requests, or visible error alerts during the Following check. The generated editorial image and live portraits loaded successfully in the inspected views.
- The built Worker homepage was also inspected in the collaborative browser. Its fonts and editorial image loaded, with no console entries, failed requests, or error alerts.
- Research, design decisions, the image asset, and its generation prompt are in [docs/redesign.md](docs/redesign.md). Earlier verification entries below describe previous revisions and their original dates.

Date: 2026-09-07. Production Worker served locally through Wrangler on port 3001.

## Automated

- TypeScript and authored-source lint pass. The unmodified scaffold component library is excluded from lint.
- Production build succeeds. Vinext reports its known static route-classification limitation for the dynamic home page; the page responds successfully at runtime.
- Six live API tests pass: actionable homepage, compound teacher/duration search, distinct paginated results, question-to-topic interpretation, actual audio and source materials, and invalid requests.

## Browser checks

- Desktop and 390px mobile layouts inspected with real content; mobile document width equals viewport width, with no horizontal overflow.
- Teacher directory search resolves Rabbi Hershel Schachter and opens his library results.
- Compound search resolves the teacher, 30-minute limit, and remaining keyword; returned results include matches beyond title words.
- Save, playlist create/add, rename, remove/undo, and restoration on a fresh page load verified.
- Timestamped note creation and restoration verified. Copy link returns success; a direct timestamp URL opens the correct shiur and starts at 15 seconds after explicit playback. Clipboard contents could not be read back through the in-app browser clipboard API.
- Two actual MP3s play successfully. Seek, queue advancement, and separate per-recording history positions verified after the final playback fixes.
- Playback speed and persisted listening progress verified. Sleep-timer selection is implemented; real-time expiration has not been waited out in this session.
- Source details retain available topic and series metadata when the detail endpoint omits those fields.
- Production browser console showed no warnings or errors during the final detail/playback checks. A later rebuild exposed stale module references in the already-running Wrangler preview; a server restart made the served chunk match the new build. Fresh-page loading and compound search then passed with no new console errors.
- WebMCP search tool valid and invalid input handling verified.

## Release conditions

The original Sites connection recovered after an earlier access failure. Publishing and deployed-origin verification follow the validated local revision.

Live content and media availability depend on YUTorah and its CDNs. This record covers the flows above; it is not a claim that every recording in the upstream archive has been individually checked, or that all browsers and assistive technologies have been exhaustively tested.

## Search and interface revision

- Six deterministic search checks pass: spelling tolerance, entity types, ambiguous teacher names, natural duration/media phrasing, Hebrew normalization, safe highlights, direct-match relevance, and centered excerpts.
- Keyboard selection of the live suggestion for “Hershel Schacter” opens Rabbi Hershel Schachter's results. Exact names take precedence over approximate matches.
- Removing the 30-minute chip expands the compound search from 14 loaded matches to 78 upstream matches, retaining the teacher.
- Expanded filters expose the matching teacher, topic, and series controls. The compact default brings the first result into the phone viewport.
- Desktop and 390px phone results inspected. The phone document width is 390px with no horizontal overflow. Small text was raised to at least 12px; primary result titles and metadata use larger sizes.
- Direct title matches rank before incidental description mentions within loaded results. Sorting is explicitly labeled as applying to loaded results.

- Production shortest-first sorting verified. Recent-search recall is available from the empty search input.

## Complete search and natural query revision, 2026-09-08

- Replaced batch-only search with resumable D1 candidate scans. Source requests stay bounded to four pages per pass; browser progress, pause/resume, and cancellation are implemented. A pass commits its records and cursor together, and failures release its lease without advancing it.
- All filtering and sorting now run against the same cached candidate set. Candidate identity excludes refinements and sort order. Final count is reported only after every source page is checked, with duplicate/missing candidates and changing source totals treated as incomplete searches.
- Seventeen deterministic tests pass, including a best match on the final upstream page, exact filtered counts, global sorting, distinct result pagination, refinement cache reuse, failed-page retry, empty results, bound filter values, natural time budgets and dates, and preserved question subjects.
- Live test checked all 9,012 teshuva candidates and returned 1,006 matches for 20–30 minutes excluding parsha. The final revision's cold scan took about 85 seconds locally; cached page retrieval took about 20 ms. These are observations, not performance guarantees.
- Live natural query resolved Rabbi Hershel Schachter, thirty minutes, newest order, and teshuva to 14 matches among 78 source candidates. Compound search, global pagination, and invalid-request regression tests pass.
- TypeScript, authored-source lint, and the Worker build pass. D1 migrations were generated and applied locally. The new UI has not received browser interaction or mobile visual testing in this revision.
- The original Sites project still returns project_not_found. No replacement project was created and the new DB-backed revision has not been published.

## Transcription pipeline and Oracle deployment review, 2026-09-30

- PR #1 is already merged into main; its pull-request and main GitHub Actions runs passed. The follow-up adds learning tests, a dependency audit gate for high/critical findings, and a compiled pipeline smoke check to the same workflow.
- Live discovery exposed a homepage feed ordered by upload, with September 29 recordings between September 30 recordings. The worker previously rejected it. Homepage ingestion now accepts upload order; paged archive ingestion retains publication-order validation. Regression tests reproduce the original failure and verify both paths.
- Two real `sync-now` CLI scans in an isolated PostgreSQL schema queued 130 distinct recordings with no duplicate jobs. The homepage and paginated backstop both completed; no production account was used.
- 45 worker checks passed with PostgreSQL 17 and FFmpeg, including queue/checkpoint persistence, lease fencing, SIGKILL recovery, startup policy, catalog ingestion and search. Seventeen deterministic search tests and twelve learning tests passed. TypeScript, lint, worker build and website build passed on Node 24.20.0.
- After the dependency updates, the built homepage rendered successfully and all six live API checks passed against the restarted Cloudflare runtime: homepage, compound search, complete pagination, question interpretation, real audio/materials, and invalid requests.
- The new `test:pipeline` command uses compiled modules and CLI commands, real WAV preparation, an ACP fixture that checks the full skill hash, persistent chunk/segment publication, database read-only grants, and the compiled search server. A built Cloudflare website with isolated migrated D1 state returns English/Hebrew timestamped results through that server; invalid queries return 400 and a stopped search backend returns 503. Missing `TEST_DATABASE_URL` fails instead of skipping.
- React/React DOM/RSC are pinned to 19.2.8, Vite to 8.0.16, and Cloudflare tooling to compatible patched releases. Vinext's pinned image-size dependency is overridden with the 2.0.3 patch. `npm audit --omit=dev` reports zero vulnerabilities. The full audit has zero high/critical findings and four moderate findings in Drizzle Kit's legacy esbuild development dependency chain; a forced downgrade was not applied.
- Cloudflare binding types are imported explicitly, preventing new Workers global declarations from replacing Node Buffer types in the shared TypeScript check. Node test registrations explicitly discard their returned promises for type-aware lint.
- [Oracle setup notes](docs/transcription-oracle.md) cover shape/OS identification, current documented A1 free allowances, Oracle ingress and the Ubuntu host firewall, DNS, authentication and commissioning. Service account creation explicitly creates the groups required by the unit and environment-file permissions.
- Automated ACP tests use a fixture. Authenticated short/long transcription, token persistence/renewal, account quota and native ARM64 execution still require the operator's VM and Google account. The pinned Google archive could not be downloaded in this review environment because the TLS connection failed; the VM's `probe` remains required. This review does not deploy Oracle infrastructure or publish the existing managed website.

## Typo and partial-word search, 2026-09-30

- Researched Solr, PostgreSQL pg_trgm, MiniSearch, Typesense, and Meilisearch.
  Selected the existing Solr metadata index and PostgreSQL transcript database;
  no new hosted service or API credentials are required. See
  [search architecture](docs/search-architecture.md).
- 88 automated checks passed: 19 matcher/parser checks, five complete-search
  checks, 12 learning regressions, 43 worker/PostgreSQL checks, and nine live API
  checks. PostgreSQL ran in an isolated local cluster with no skipped tests.
- Live submitted searches verified teacher-name typos, shortened subject words,
  a transposed partial word outside the directory vocabulary, complete totals,
  pagination, question interpretation, and strict input handling. The live suite
  scanned every candidate for its broad queries and took about five minutes.
- Desktop (1280 × 900) and mobile (390 × 844) Chrome checks passed. Typing
  `Hershl Schact` suggested Rabbi Hershel Schachter. Submitting
  `teshvu by Rabbi Hershl Schact under thirty minutes` returned 15 matches among
  102 candidates, with teacher ID 80153 and the 30-minute limit applied. The
  transcript selector defaulted to tolerant matching and supported switching to
  exact phrase. No browser errors, failed requests, or mobile horizontal overflow
  occurred. The collaborative preview host was unavailable, so these checks used
  headless Chrome through Playwright.
- The transcript migration was additionally checked against pre-existing rows:
  vocabulary backfill, insert/update maintenance, window indexing, and SELECT
  access for the existing read-only role all passed.
- TypeScript, lint, the worker build, and the production website build passed.
  Apply the new PostgreSQL migration before restarting an existing transcript
  search service; metadata requires no new D1 schema migration.
