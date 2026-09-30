# Verification record

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
