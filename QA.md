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
