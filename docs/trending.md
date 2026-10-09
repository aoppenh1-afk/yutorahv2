# Trending by upload cohort

The page offers 24 hours, week, month, year and all time. Week, month and year mean rolling 7, 30 and 365 days. It ranks lifetime YUTorah views among shiurim uploaded in that window. Actual views earned during a selected period would require historical counter snapshots. Recording dates remain separate from upload dates. All time includes archival records without upload timestamps; duration filters exclude unknown lengths.

## Shared indexing

All twenty period/duration charts use **one persisted library traversal**. The public `/api/discover` endpoint calculates daily and weekly on demand. Month, year and all-time requests only read completed server-side charts; they never contact YUTorah or advance a scan. The protected `/api/discover/refresh` endpoint lets a background runner build every chart without a browser open. The API returns only the requested chart. Its coverage bitmap, candidates, chart map and cursors remain server-only.

`lib/trending-index.ts` freezes the upload windows when the scan starts. It counts each unique ID once, ranks each cohort independently, and retains only the union of the twenty top-thirty lists. The one-bit-per-ID coverage bitmap prevents overlapping offset pages from inflating coverage. Candidate metadata and counters use the first observation of each ID during that scan. These are reads from a changing upstream library, not an atomic snapshot. A decreasing source total that falls below accumulated coverage invalidates the scan. Offset gaps cause another pass rather than a false completion claim. Failed or invalid pages are saved for retry on the next request, ahead of new pages.

The first request reads up to 12 pages. Later requests read up to 36, with at most six upstream requests active at once and an eight-second request deadline. One upstream page contains thirty records. Database leases coordinate server instances; in-process promises coalesce requests for different chart variants. The lease lasts sixty seconds, longer than the bounded read pass. Partial passes are cached for three seconds.

`lib/trending-source.ts` uses the public `https://api.yutorah.org/search/get` endpoint. It streams through the complete JSON `response` object and cancels the remaining body. The API sends a multi-megabyte facet dictionary even with `getFacets=false`; none of that dictionary is needed for trending. The parser handles nested objects, strings, escapes and split UTF-8 sequences, rejects incomplete results, and bounds the results prefix to two million characters.

The index uses the existing `search_runs` row `trending:v1:shared:2`. No schema migration is needed. Search cleanup already excludes the reserved `trending:v1:*` namespace. Legacy per-chart rows are no longer used by production trending. Their older readers remain available in `lib/discovery.ts` for the existing source adapter tests.

Completed shared charts are fresh for twelve hours. The next rebuild keeps the previous completed rankings visible, with `refreshing: true`, while advancing the replacement index. Long-range chart reads retain completed results for up to seven days so a slow rebuild or upstream outage does not send users back into an archive scan. The UI shows the original update time and polls for a replacement. If no completed chart exists, long-range reads return 503 immediately without changing saved progress. Daily and weekly retain the existing on-demand behavior and 24-hour fallback. Corrupt shared snapshots are rejected before use.

The cache key and snapshot format are unchanged. A scan already running on the deployed site can populate this cache. The warmer resumes its cursor and shares its database lease; a local dev server only shares that work if it uses the same database. Deploying the new public endpoint stops browser-driven month/year/all-time passes, so configure and run the background warmer before relying on it to finish an ongoing scan.

## Upstream limits and measurements

Live probes on October 8, 2026 found:

- The website search endpoint returned a Cloudflare challenge. The mobile API ignored the attempted popularity sort and did not accept the attempted upload-range search as a field filter.
- A mobile page reported about 434,000 records in the full library and included approximately 5.51 MB of decoded JSON for thirty records.
- Reading the results prefix consumed about 47.5 KB in the sampled page. This measures decoded bytes consumed by the application, not guaranteed network-wire savings. The upstream server still took about 1.5 seconds for that individual page.
- Two live index passes retained 360 then 1,440 unique records, with no failed-page retries. All twenty chart variants shared that coverage. Those passes took about 10 and 26 seconds in that run; they are not a full-library benchmark.

An exact cold chart still needs the first full-library traversal. Daily and weekly also share that traversal: they are not guaranteed to be quick on a cold cache because the upstream API ignores upload filters. Do not stop at the first old recording date: a recently uploaded shiur can have an old recording date and appear much later in the API's order. Background warming removes that work from long-range page requests. Upload windows and completed-chart timestamps stay visible so users can assess freshness. Recent zero-view records count toward coverage but do not occupy the viewed chart.

## Warming and verification

Set `TRENDING_REFRESH_TOKEN` privately in the deployed server environment (a Cloudflare binding or Vercel environment variable) and in the runner environment. Warm any chart through the authenticated endpoint to build the shared index for every chart:

```sh
npm run trending:warm -- --url https://YOUR_SITE --period all --refresh
```

The command sends the token in an Authorization header and does not follow redirects with it. The server requires durable storage; failed cache writes cannot be reported as a completed warm. The command resumes persisted progress and waits for an in-progress rebuild to complete. Omitting `--period` verifies all five periods after the shared scan. `--minutes 10`, `20` or `30` selects a duration variant without starting another index. The command has a pass budget; interrupted runs can be resumed. Without `--refresh`, it uses the public endpoint: daily/weekly can advance the scan, while long-range periods only check saved charts.

`.github/workflows/trending.yml` runs the warmer every six hours and supports a manual run. Set the repository variable `TRENDING_SITE_URL` to the deployed site and the repository secret `TRENDING_REFRESH_TOKEN` to the same server token. Its concurrency group prevents overlapping scheduled runs; database leases also coordinate browser and server-instance work. Fresh completed indexes return immediately without a rebuild. Scheduled workflows run from the default branch, so the workflow must be merged there to become active. See [GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

`npm run test:learning` includes regressions for cache-only long-range reads, authenticated background resumption of browser progress, failed persistence, multi-day completed-chart retention, cold reads without upstream work, cross-period resumption through real SQLite persistence, simultaneous variants, all twenty rankings against a full reference dataset, late winners, duration/date boundaries, Unicode streaming and facet cancellation, failed pages, outages, overlapping pages, shrinking totals, corrupt state and API privacy. `node --test --test-name-pattern='long-range requests' tests/trending.test.mjs` verifies that expired saved charts cause no upstream request. Use Node 22.13 or newer for SQLite tests.
