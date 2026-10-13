# Trending by upload cohort

The page offers 24 hours, week, month, year and all time, each with the existing 0, 10, 20 and 30 minute filters. These rank lifetime YUTorah views among recordings uploaded in the selected window. They do not measure views earned during that period. Recording dates remain separate from upload dates. All time includes archival records without upload timestamps; duration filters exclude unknown lengths.

All twenty charts share one persisted index and one database lease. Public daily/weekly requests can advance it. Month, year, all-time and `cached=1` requests only read saved charts. The protected refresh endpoint advances the same index. Saved rankings remain available during rebuilds and outages. No metadata-search hits are created and no database migration is required.

## Confirmed failure and upstream evidence

Investigation on October 13, 2026 examined the code and downloaded workflow logs:

- [Run 38269360437](https://github.com/aoppenh1-afk/yutorahv2/actions/runs/38269360437) logged 249 observations at exactly 434,510 indexed IDs between 16:09:33 and 18:20:10 UTC on October 12. The reported total grew from 434,583 to 434,602. It was cancelled after the 180 minute timeout.
- [Run 38328152761](https://github.com/aoppenh1-afk/yutorahv2/actions/runs/38328152761) started at 434,510/434,645, repeated historical coverage, and later restarted with much lower coverage. Totals also decreased during its traversal. The old `sampled > libraryTotal` branch discarded the checkpoint on a decrease. The logs alone do not identify which particular IDs were missing or prove that every gap was an insertion.
- Of the twelve available workflow runs, nine were cancelled. Their summed elapsed time was approximately 1,624 minutes, calculated from creation/update timestamps. This is elapsed workflow time, not an exact GitHub billing measurement.

The root defect was offset traversal against a mutable result set combined with historical-union completion detection. The cursor wrapped to page one and traversed thousands of known pages again. New records could appear behind an already passed cursor. Failed pages were always retried ahead of new pages, without backoff. The warmer treated every successful partial response as useful work and had no stall detection; 2,000 passes could outlast the workflow timeout. A historical ID union equalling a changing total was also insufficient evidence of current coverage after removals and replacements.

The [public OpenAPI specification](https://api.yutorah.org/swagger/v1/swagger.json) exposes page-number search and teacher/category/series/location/collection filters. It does not document an ID cursor, snapshot token, deterministic sort, page-size control or changes feed. Live probes found:

- Pages one and two returned thirty records each and reported 434,655 results. Page 14,489 returned fifteen records.
- `sort_by=shiurid desc` and an ID-range `facet_query` returned the same first IDs as the unfiltered baseline. `pageSize=120` still returned thirty records. An ID-range expression in `searchTerm` produced five text matches outside the requested ID range.
- The website keyset route `/Search/GetSearchResults` returned HTTP 403 with a Cloudflare challenge on both website hosts; that route on the mobile API host returned 404.
- Successful sampled page probes took approximately 0.3–2.0 seconds. Other probes timed out at 12 or 20 seconds; a later cold-index probe also hit the eight-second first-page deadline. These are individual requests, not a full-library speed benchmark.

## Coverage contract

Exact membership at one instant cannot be guaranteed through the documented and tested public API. Equal totals can hide replacements between requests. Record counters and metadata also change between page reads. A guaranteed global snapshot would require upstream snapshot/cursor support or an authoritative inventory plus a changes feed. The index does not guess IDs, trust unverified query parameters, accept 99.98%, or stop at an old recording date.

A new scan keeps an independent census bitmap, cohort counts and top candidates in addition to the historical recovery union. A census can be **reconciled** only after its cursor traverses the library, all failed pages succeed, every response reports the same total, and its unique ID count equals that total. It then replaces the union's candidates and counts with that census, removing historical winners that disappeared. A changed total or count mismatch starts another independent census while preserving the union and saved rankings. A full sweep with no new IDs, or exhaustion of two immediate traversal rounds, defers further reconciliation for twelve hours. Coverage remains explicitly unresolved.

`partial=false` describes this successful observed census, not a guaranteed atomic upstream snapshot. Every new index response exposes `coverage.guaranteed=false`. The UI and warmer explain this limitation. Continuous upstream changes may prevent a census from reconciling; such scans stay partial and pause rather than manufacture completion. Partial rankings and cohort counts are provisional and use first observations in their scan. Upload windows remain frozen at the scan's `before` timestamp.

The existing `trending:v1:shared:2` row and version-two union remain readable. Legacy partial progress resumes without throwing away its bitmap or rankings, but must pass an independent census. A legacy completed union remains available for display and triggers a census once before the new refresher considers it fresh. A process interrupted before saving a pass repeats that pass from the last committed checkpoint.

## Bounded work and recovery

The first request budgets twelve upstream requests; subsequent passes budget thirty-six. A resumed pass checks the head and follows new records until it reaches a completely known page, for up to four head requests. Its separate head cursor persists when an outage added more records than fit in that budget. This finds newly inserted head records without walking the entire archive first. Insertions elsewhere, removals and arbitrary reordering are checked by the independent census.

At most six requests run concurrently. A worker pool starts another page when a connection becomes free, so a slow page does not block five healthy peers at a batch barrier. Each request has an eight-second deadline, and the entire upstream pass has a forty-five-second deadline. The database lease lasts seventy-five seconds to allow persistence after upstream work. The streaming response parser consumes the results object and cancels unused facets, retaining its JSON/UTF-8 validation and size limit.

Invalid pages include missing documents, duplicate IDs within a page, incorrect reported page numbers, invalid IDs and invalid counters. Failed pages remain in the checkpoint. Retries wait thirty seconds, then sixty seconds, then six hours after the third failure. Each pass reserves at most six slots for due retries and continues archive enumeration with the remaining budget. An outage saves failure/backoff state along with successful progress. No unavailable page is treated as covered.

A paused checkpoint returns without upstream work or a database write until its retry time. Successful persistence releases the lease in the same update, avoiding an extra write. Protected refresh responses report the active checkpoint even when public requests show the previous chart. They include a `Retry-After` header when paused. Leases and in-process promises still coordinate all periods and duration variants. Fresh reconciled results are reused for twelve hours.

## Running the warmer

Set `TRENDING_REFRESH_TOKEN` in the deployed server environment and runner environment. The token is sent in an Authorization header; authenticated requests do not follow redirects.

```sh
npm run trending:warm -- --url https://YOUR_SITE --period all --refresh --max-passes 1000 --max-minutes 20
```

The runner logs historical unique counts, census coverage, round, cursor, pending failures, upstream request count and added IDs. Cursor movement counts as progress even when a reconciliation visits known IDs. Four identical progress responses stop a stalled runner, including against an old deployed server. Network errors, HTTP 503 and stale responses have three bounded attempts with backoff. Long server backoffs and paused checkpoints exit immediately rather than keeping an Actions runner asleep. A fresh reconciled chart returns immediately. Deploy the server changes alongside the runner so it can expose census progress.

Runtime-budget exhaustion, pauses and temporary outages return a `deferred` outcome with exit status zero. This means work was checkpointed or could not continue; it does not mean coverage is complete. Reaching the explicit pass limit returns exit status two. Invalid configuration and non-retryable HTTP errors fail. The GitHub step summary records the outcome, separately from the workflow's success status. Omitting `--period` checks all five charts through the same index.

The workflow retains its six-hour schedule so unfinished scans resume regularly. Its twenty-minute work budget exits before the twenty-five-minute job timeout. It installs only pinned `tsx`, rather than the full application dependency tree. Concurrency prevents overlapping scheduled runs. A complete scan does not need to fit in one job; partial and audit progress survives the next scheduled invocation. Once reconciled, the twelve-hour freshness window makes intervening scheduled runs checks rather than full rebuilds.

A synthetic worker-pool comparison against the original implementation used three resumed passes per implementation, with six 30 ms slow pages interleaved with 1 ms pages. Mean pass time was 238 ms before and 152 ms after, approximately 36% lower. The original pass added 1,080 IDs; the new pass added 1,050 because one request reconciled the head. This measures mocked request latency plus local processing, not production throughput.

The new twenty-minute budget is approximately 89% below the old 180 minute timeout for a wasteful run, excluding setup. This is a configured bound, not measured production savings. Head reconciliation adds a small request overhead; a changing library can require another full census. A library of 434,655 records still needs at least 14,489 thirty-record page reads per census. There is no verified upstream shortcut for refreshing all lifetime view counters, and total cold-scan time and billing savings must be measured after deployment.

## Verification

`npm run test:learning` runs the trending regressions alongside the learning, library and discovery tests. Trending tests cover the 434,510/434,602 stall, moving totals, offset shifts, same-total replacements, removed winners, duplicate pages, short/misplaced pages, persistent failures, backoff, restart recovery, census stalls, all twenty rankings against full fixture data, legacy migration, fresh-cache reuse, lease coordination, streaming parsing, API privacy, active refresh progress and bounded runner exits. Type-check and lint the changed TypeScript files as well.

October 13 verification passed 84 learning/discovery/library/trending tests, including 54 trending tests; the API suites passed 21 upstream and 7 view-counter tests. TypeScript checking, scoped lint and diff whitespace checks passed. The pinned workflow command also succeeded in an isolated directory without installed application dependencies, against an authenticated HTTP fixture. A live cold-index attempt timed out on page one, so no full production scan benchmark or deployment verification is claimed.
