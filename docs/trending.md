# Trending by upload cohort

The page offers 24 hours, week, month, year and all time. Week, month and year mean rolling 7, 30 and 365 days. It ranks lifetime YUTorah views among shiurim uploaded in that window. Dividing views by age would measure an average rate, and would not recover views earned during the selected period. Actual rolling view totals would need historical counter snapshots.

Upload time comes from `shiurdatesubmitted` or `shiurDateSubmitted`. Recording time remains a separate field. The [YUTorah search page](https://www.yutorah.org/search/) distinguishes date given from date uploaded, and its [search script](https://www.yutorah.org/js/search/main.js) uses the public `Search/GetSearchResults` endpoint with `sort_by` and `facet_query`. Upload-date filters use inclusive [Solr ranges](https://solr.apache.org/guide/solr/latest/query-guide/standard-query-parser.html). Timestamped values retain their UTC offsets. The legacy endpoint's unzoned values use Eastern time, consistent with paired mobile API responses. Some upstream dates have day precision, so the interface discloses that limitation for the 24-hour view.

Live research on October 2, 2026 found that the mobile API ignored view-sort query parameters. The website endpoint returned HTTP 500 for the requested view-count sorting, and later probes encountered Cloudflare challenges. The implementation therefore uses the site's ID ordering and ranks locally. It does not depend on a successful upstream view sort. Server-side access to that public endpoint is still required; a Cloudflare challenge produces an explicit unavailable state or a previously cached chart.

Each request reads at most 30 matching records. The query filters upload time and duration before retrieval, then orders by descending ID. Subsequent requests add an upper ID bound. A fixed upload window prevents later uploads from shifting the scan's offsets. Each pass checks the remaining count, strict ID ordering, view counters, date bounds and durations before advancing the cursor. The chart is complete only after all matching records have been scanned. Zero-view records count toward coverage but do not occupy the viewed chart. Downloads, upload date and ID break view ties.

While indexing, the page displays coverage and provisional rankings, then requests the next pass. A winner on a later page can replace an earlier result. The home preview also identifies incomplete coverage. Automatic indexing only runs on the trending page and refreshes that chart independently of follows, related learning and the homepage feed.

The existing search database stores twenty reserved `trending:v1:*` rows, one per period and duration combination. Each row contains at most thirty provisional winners, a scan cursor and the last completed top thirty. A failed rebuild can therefore keep serving the completed chart. No archive-sized payload table, new credentials or schema migration is required. Ordinary search cleanup excludes these reserved rows. In-process promises coalesce requests; database leases coordinate separate server instances. Incomplete passes are cached for three seconds. Completed day and week charts are cached for five minutes, month charts for thirty minutes, year charts for six hours and all-time charts for twelve hours. Source failure keeps a cached snapshot for at most 24 hours, retains its timestamp and bounds retries. Incomplete or stale responses bypass CDN caching.

Large cohorts require an initial scan, especially all time. The upload window's end is displayed separately from the last indexing update so a long scan does not silently move the meaning of “past week.” A cohort whose remaining count changes must restart, rather than claim complete coverage. Source access failures do not turn into successful empty charts.

Warm charts before opening the page, or schedule the same command from an existing job runner:

```sh
npm run trending:warm -- --url https://YOUR_SITE --period week
npm run trending:warm -- --url https://YOUR_SITE --period all --max-passes 20000
```

Omit `--period` to warm all five periods. Use `--minutes 10`, `20` or `30` to warm a duration variant. The command is rate limited, has a pass budget and resumes the persisted cursor after interruption. An all-time cold scan can take hours. The command fails visibly on an upstream error, rather than endlessly retrying a blocked endpoint.

Tests cover rolling boundaries, Eastern offsets, recorded versus uploaded dates, duration filtering before limiting, winners beyond the first page, incomplete source responses, duplicate and out-of-order IDs, changed cohorts, persistent scan resumption, leases, cache expiry and stale failure recovery.
