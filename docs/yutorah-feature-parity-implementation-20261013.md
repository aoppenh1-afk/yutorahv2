# YUTorah feature parity implementation — October 13, 2026

The accepted scope contains 17 findings from [the public-site audit](yutorah-feature-parity-audit-20261013.md). Fourteen are implemented and verified locally. Three share an upstream integration dependency: YUTorah’s original archive-search endpoint rejects server requests with HTTP 403. The publication directory, route handling, filters, adapter, and recovery UI are implemented, but publication/volume article retrieval and legacy multi-ID search cannot be called fully operational while that endpoint is unavailable.

Changes are local and uncommitted. This work has not been deployed. Existing notifications remain in place; no email-alert delivery was added.

## Scope and behavior

| Finding | Status | Result |
| --- | --- | --- |
| G01 — Official collections | Implemented | Searchable directory; ordered lessons; collection progress; start/continue and queue; previous/next lessons and memberships in shiur details. |
| G02 — Publications and volumes | Upstream dependent | Publication directory, profiles, original links, publication/volume filters, and paginated archive adapter. Article lists and scoped volumes need working archive API access. |
| G03 — Venues | Implemented | Searchable venue directory, venue profiles, scoped search, and venue attribution. |
| G04 — Original URL compatibility | Implemented with upstream dependency | Teacher, series, category, venue, collection, publication, Daf and search links retain IDs, restrictions, sort, and given/uploaded date ranges. Multiple IDs retain OR semantics; their archive retrieval currently shares the 403 dependency. |
| G05 — Given versus uploaded dates | Implemented | Separate date basis, sorting and ranges; simultaneous legacy ranges preserved. Upload-day boundaries use New York time, including daylight-saving transitions. Missing upload timestamps are not substituted with lecture dates. |
| G06 — Daf workspace | Implemented | Tractate/page/amud selection; scanned daf; enlarge; previous/next amud; associated and related recordings; speaker filter; side counts; Sefaria link. |
| G07 — Chapters | Implemented | Collapsible timed chapter list; selecting a chapter seeks the existing player. |
| G08 — Official summaries | Implemented | Dedicated Summaries tab with overall and timed chapter summaries; source/provenance copy; refresh and retry. |
| G10 — Entity landing pages | Implemented | Teacher, series and topic profiles with available biographies, recent/most-viewed/featured recordings, related entities, follows and scoped search. |
| G11 — Contextual counts | Implemented with upstream dependency | Counts use distinct matching records after the complete candidate scan. Teacher/topic/series/venue/collection facets are verified. Publication/volume counts need the unavailable archive data. Full-library counts are labeled separately while results are incomplete. |
| G14 — Article reader and print | Implemented | Embedded native PDF reader with print, open and download. Server proxy validates the source host, redirect, PDF signature and size. |
| G15 — All speakers and authors | Implemented | Author arrays and IDs survive normalization, storage and search; all authors link to native profiles. |
| G16 — Category hierarchy | Implemented | Subject group/branch/topic paths in directories, refinement choices and detail attribution; ID-based navigation avoids ambiguous names. |
| G17 — Selected batch actions | Implemented | Opt-in checkboxes; selected count; loaded-result select/clear; save, audio queue and playlist actions; deduplication and multi-item playlist creation. |
| G22 — Editorial campaigns | Implemented | Official campaigns and collection cards on Featured; supported links open native app pages and unsupported resource links retain the original destination. |
| G25 — Feedback and reports | Implemented | Interface feedback and content reports with page/shiur context; content reports target YUTorah’s errors address. Users review and send the draft in their email app. |
| G27 — Storage/sync explanations | Implemented | Copy distinguishes storage on this device from signed-in sync, including pending/error states. |

Excluded as requested: reflections/quizzes (G09), RSS/podcast subscriptions (G12), email alerts (G13), and every P3 finding (G18–G21, G23–G24, G26). Feedback drafts are separate from notification subscriptions.

## UI decisions

- One Browse entry contains the six entity directories, replacing three separate navigation entries.
- The primary search controls retain their existing layout. Additional entities open inside Refine; each entity selector expands only when needed. Words/source and secondary date constraints use disclosures.
- Batch controls appear only after Select results is enabled. On phones, filters and result tools use the existing collapsible sections.
- Chapters are collapsed by default. Summaries use their own tab. Extra attribution sits in a disclosure.
- Report an issue sits beside the original-source link, keeping the main audio actions to one row.
- Editorial campaigns appear on Featured. Existing type, spacing, borders, colors and row components are reused.
- Mobile overflow from a long selected collection name was found in browser review and fixed with shrinking/ellipsis behavior.

## Verification

| Check | Result |
| --- | --- |
| `npm run test:parity` | 12 passing |
| `npm run test:search` | 44 matcher tests and 60 integration/storage/index tests passing |
| `npm run test:learning` | 90 passing |
| `npm run test:api` | 28 passing |
| `npm run test:performance` | 1 passing |
| `npm run test:account-library` | 11 passing; 1 database integration test skipped without local Postgres |
| `npm run test:notifications` | 10 passing; 1 database integration test skipped without local Postgres |
| `npx tsc --noEmit` | Passing |
| `npm run lint` | Passing |
| Cloudflare build and bundle budgets | Passing |
| Vercel build and bundle budgets | Passing |
| `git diff --check` | Passing |

Meaningful regression coverage includes legacy restrictions and simultaneous dates, New York upload boundaries, all authors, hierarchy, chapter normalization excluding quiz data, OR filters, contextual counts, last-page matches, and archive paging when the upstream native page size differs from the app’s page size. An empty scoped search now sends `*` to the native search API; a collection that previously returned zero candidates is verified to return all thirteen lessons with upload metadata intact.

Browser checks used the Chrome computer-use extension on the local app. They covered directory/profile navigation, collection ordering and lesson boundaries, chapter seeking, summaries, both amud choices, PDF reading/printing, selected save/queue/playlist actions and contextual reporting. The PDF print action opened Chrome’s seven-page print preview; printing was canceled. Local QA saved items, queue entries and the test playlist were removed afterward. No feedback message was sent.

Responsive checks covered Browse, collections, search/refinements and Daf at 390 × 844. The checked pages have no horizontal document overflow. Desktop and mobile screenshots are captured from settled app states. Upstream content and counts can change between captures.

Graph navigation used task-directed Tier 2 evidence. Coverage was checked for changed application, route, model and test files; recorded parser gaps were read directly. Tests and runtime observations establish behavior, rather than graph relationships alone.

## Remaining external dependency

`https://yutorah.org/Search/GetSearchResults` returns HTTP 403 to the server-side archive adapter. Native mobile search supports the single teacher/topic/series/venue/collection scopes, but did not supply working publication/volume restrictions. Publication landing endpoints did not provide an alternative article list. The adapter does not drop restrictions or replace a failed archive query with unrelated results.

The Hakirah Journal profile (ID 247) currently returns its directory name/count plus an explicit unavailable state, retry and original-site link. Failed profile responses use `no-store` and are excluded from the success cache. Publication/volume search and legacy multi-ID search require supported upstream API access to finish live verification. The native `shiurPublication` field is treated as a volume key; volume labels are not guessed to be parent-journal names.

## Screenshot review

The [interactive review](yutorah-feature-parity-review-20261013.html) contains before/after comparisons for default search, expanded Refine, the teacher directory/Browse and shiur details, plus new desktop screens and mobile captures. New pages have no previous in-app equivalent.

Original captures are in `work/feature-parity/screenshots/`. Build, lint, typecheck, search, parity and bundle-budget logs are in `work/feature-parity/`; this directory is ignored by Git. The review HTML is kept in `docs/` and uses those local screenshot files when viewed from this workspace. T3 embeds the image bytes when rendering it in the conversation.
