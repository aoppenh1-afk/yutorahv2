# YUTorah feature parity implementation — October 13, 2026

The initial implementation covered 17 findings from [the public-site audit](yutorah-feature-parity-audit-20261013.md). Following review, the user requested the original circular teacher cards, Featured shiurim without campaign cards, and removal of publication browsing. Those changes are implemented on desktop and mobile. Publication and volume controls are removed from Browse, Refine and shiur details. Deprecated publication routes return to Browse; original-site publication links retain their external destination.

The remaining archive dependency concerns legacy searches with multiple entity IDs. Their adapter preserves the restrictions, but YUTorah's original archive endpoint still rejects server requests with HTTP 403.

The latest frontend revisions are local and uncommitted. The venue/collection follow migration was applied to the live Supabase database on October 13, 2026. Existing notifications remain in place; no email-alert delivery was added.

## Scope and behavior

| Finding | Status | Result |
| --- | --- | --- |
| G01 — Official collections | Implemented | Searchable directory; ordered lessons; collection progress; start/continue and queue; previous/next lessons and memberships in shiur details. |
| G02 — Publications and volumes | Removed by request | Publication browsing, profile pages, volume selectors and detail actions are removed. Deprecated routes return to Browse. |
| G03 — Venues | Implemented | Searchable venue directory, venue profiles, scoped search, and venue attribution. |
| G04 — Original URL compatibility | Implemented with upstream dependency | Teacher, series, category, venue, collection, Daf and search links retain IDs, restrictions, sort, and given/uploaded date ranges. Source publication links stay on YUTorah; deprecated in-app publication pages return to Browse. Multiple IDs retain OR semantics; their archive retrieval currently shares the 403 dependency. |
| G05 — Given versus uploaded dates | Implemented | Separate date basis, sorting and ranges; simultaneous legacy ranges preserved. Upload-day boundaries use New York time, including daylight-saving transitions. Missing upload timestamps are not substituted with lecture dates. |
| G06 — Daf workspace | Implemented | Tractate/page/amud selection; scanned daf; enlarge; previous/next amud; associated and related recordings; speaker filter; side counts; Sefaria link. |
| G07 — Chapters | Implemented | Collapsible timed chapter list; selecting a chapter seeks the existing player. |
| G08 — Official summaries | Implemented | Dedicated Summaries tab with overall and timed chapter summaries; source/provenance copy; refresh and retry. |
| G10 — Entity landing pages | Implemented | Teacher, series and topic profiles with available biographies, recent/most-viewed/featured recordings, related entities, follows and scoped search. |
| G11 — Contextual counts | Implemented | Counts use distinct matching records after the complete candidate scan for the supported teacher/topic/series/venue/collection filters. Full-library counts are labeled separately while results are incomplete. |
| G14 — Article reader and print | Implemented | Embedded native PDF reader with print, open and download. Server proxy validates the source host, redirect, PDF signature and size. |
| G15 — All speakers and authors | Implemented | Author arrays and IDs survive normalization, storage and search; all authors link to native profiles. |
| G16 — Category hierarchy | Implemented | Subject group/branch/topic paths in directories, refinement choices and detail attribution; ID-based navigation avoids ambiguous names. |
| G17 — Selected batch actions | Implemented | Opt-in checkboxes; selected count; loaded-result select/clear; save, audio queue and playlist actions; deduplication and multi-item playlist creation. |
| G22 — Editorial campaigns | Reverted by request | Featured contains only the original featured shiurim. Campaign and editorial collection cards are removed. |
| G25 — Feedback and reports | Implemented | Interface feedback and content reports with page/shiur context; content reports target YUTorah’s errors address. Users review and send the draft in their email app. |
| G27 — Storage/sync explanations | Implemented | Copy distinguishes storage on this device from signed-in sync, including pending/error states. |

Excluded as requested: reflections/quizzes (G09), RSS/podcast subscriptions (G12), email alerts (G13), and every P3 finding (G18–G21, G23–G24, G26). Feedback drafts are separate from notification subscriptions.

## UI decisions

- One Browse entry contains the five supported entity directories, replacing three separate navigation entries.
- The primary search controls retain their existing layout. Additional entities open inside Refine; each entity selector expands only when needed. Words/source and secondary date constraints use disclosures.
- Batch controls appear only after Select results is enabled. On phones, filters and result tools use the existing collapsible sections.
- Chapters are collapsed by default. Summaries use their own tab. Extra attribution sits in a disclosure.
- Report an issue sits beside the original-source link, keeping the main audio actions to one row.
- Featured displays only shiurim. Teacher cards reuse the original centered layout and circular 148px desktop / 116px mobile portraits.
- Mobile overflow from a long selected collection name was found in browser review and fixed with shrinking/ellipsis behavior.

## Verification

| Check | Result |
| --- | --- |
| `npm run test:parity` | 13 passing |
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

`https://yutorah.org/Search/GetSearchResults` returns HTTP 403 to the server-side archive adapter. Publication and volume browsing have been removed from the product. The adapter remains for legacy searches that contain multiple entity IDs; it does not drop those restrictions or replace a failed request with unrelated results.

## UI review changes

The teacher cards use their original markup and responsive CSS on desktop and mobile, including centered circular photographs and Follow buttons. Native profile navigation is retained. Teacher profile photos also use circles. Featured now displays only its featured shiurim, and publication/volume choices and links no longer appear in the UI. The catalog API no longer accepts publication directories/profiles or supplies publication/volume facet options.

The revision checks include 13 parity tests, 28 API tests, typecheck, lint, both production builds, bundle budgets and browser checks. Revision screenshots and logs are in `work/ui-refinements-20261013/`. The [revision review](yutorah-ui-refinements-20261013.html) compares the previous and revised desktop/mobile teacher cards and Featured tab.

## Screenshot review

The [initial interactive review](yutorah-feature-parity-review-20261013.html) is a historical snapshot from before the requested UI revision. It contains before/after comparisons for default search, expanded Refine, the teacher directory/Browse and shiur details, plus new desktop screens and mobile captures. New pages have no previous in-app equivalent.

Original captures are in `work/feature-parity/screenshots/`. Build, lint, typecheck, search, parity and bundle-budget logs are in `work/feature-parity/`; this directory is ignored by Git. The review HTML is kept in `docs/` and uses those local screenshot files when viewed from this workspace. T3 embeds the image bytes when rendering it in the conversation.


## Catalog follows, artwork and topic restoration

Venue and collection follows now use the existing private account library, alongside topic and series follows. Catalog cards and profiles expose the same follow control. The Following feed requests the correct scoped sources and matches their IDs; collection membership and venue metadata survive sparse duplicate records. Teacher follows retain their existing notification tables.

Migration `202610130009_catalog_follows.sql` was applied to the existing Supabase project. It validates catalog follow keys and values while retaining owner-only RLS, authenticated RPC writes, conflict handling and unfollow tombstones. A repeated deployment verified migration idempotence. Live disposable-account verification covered a second device restoring all catalog follow types, unfollow/refollow propagation, stale imports, and account isolation; fixtures were removed.

The original colored topic cards and subject sections are restored on desktop and mobile using the existing CSS and a shared card component. Series and venue images use catalog artwork. Collection cards load artwork near the viewport, and profiles use the collection's own image field. Legacy `///filename` values resolve only to a matching catalog asset; absent or broken images retain a book mark. Collection images no longer inherit the first lesson's teacher portrait. Search controls retain their existing layout.

Validation: 12 account-library tests pass against disposable PostgreSQL (none skipped), 92 learning/library/discovery tests pass, 15 parity/artwork tests pass, and 28 API tests pass. Typecheck, lint, Cloudflare and Vercel production builds, and both bundle-budget checks pass. Browser checks cover topic grouping/search, real series/collection image loading, following feeds, and desktop/mobile layouts. See the [catalog review](yutorah-catalog-follow-review-20261013.html) for actual before/after Chrome captures. Logs and screenshots are under `work/catalog-sync-20261013/`.


## Topic and statistics refinement

The topic directory now uses the same cards as the other catalog directories.
Subject filters remain, ordered Gemara, Mishna, Parsha, Holidays, Machshava,
then the remaining subjects in their previous relative order, with History last.
The all-subject view follows the same group ordering.

Collection artwork now resolves its image URL before rendering through the
shared portrait loader used by shiur cards. Images retain their full aspect ratio
and try the larger portrait variant before falling back. The reported Yamin
Goldsmith portrait now loads at 240×280 rather than 50×50.

Collection learned-count bars, daily totals, weekly listening totals, streaks
and daily-goal settings are removed on desktop and mobile. Daily listening-time
tracking and goal-based recommendation scoring are retired. Per the user's
clarification, individual learned controls, the learning-status search filter,
and continue-learning behavior remain. Legacy account fields stay compatible.

The refinement checks include 16 parity/artwork/ordering tests, 92 learning
tests, 11 account-library client tests and 28 API tests. The unchanged SQL test
is skipped without a running disposable database; live account isolation and
follow synchronization were verified in the preceding revision. Typecheck,
lint, both builds and both bundle-budget checks pass. Actual Chrome screenshots
are in `work/ui-polish-20261013/screenshots/`.

## Catalog loading

Teachers and series reuse the directory requested when the app opens, including
their artwork URLs. Venues use a separate directory request. Collection search
facets omit cover URLs, so visible collection cards look up their artwork after
the directory renders. The upstream artwork source is the complete collection
response, including its lessons. A direct read for collection 6536 downloaded
5,637,718 bytes in 4.824 seconds in this environment. This is a single upstream
measurement, not a guaranteed page-load time.

The public catalog loader now coalesces in-flight requests and retains successful
responses in a bounded 64-entry, 4 MiB client cache. Directory/profile responses
expire after a minute; artwork metadata expires after an hour. Failures and
unavailable responses remain retryable. Account endpoints are excluded. Cached
cards and cover URLs are available on the first render of a repeat visit.
Browse hover/focus and mounting start the collection and venue directory requests
without waiting for their tabs to be selected. Artwork remains lazy to avoid
downloading full lesson lists for unseen cards. The first uncached cover still
depends on YUTorah's full collection response. No layout or styling changed.

Regression coverage reproduces the previous six requests for two directories
and a cover across two visits, now three, plus concurrent cover coalescing,
expiry, retries, cache bounds, preloading and the first rendered card/image.
The parity suite contains 23 passing tests. Chrome verification shows 36 cards
and a loaded cover on returning to Collections, without a loading indicator.
Typecheck, lint, both production builds and both bundle-budget checks pass. Logs are in
`work/catalog-performance-20261013/`.
