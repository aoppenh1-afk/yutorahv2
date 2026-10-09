# Shiur view counts

Shiur cards, rows, featured recordings, trending lists, and details show YUTorah's public lifetime view totals. Counts use commas and singular/plural labels. Zero is a valid count; unavailable counters stay hidden.

Search results supply `shiurvisitsnum`. The homepage and shiur detail API currently omit it. Numeric ID searches against `https://api.yutorah.org/search/get?searchTerm=1150000&start=1` return the corresponding search record. The adapter accepts only an exact ID match and a nonnegative safe integer. It reads the results prefix with the existing streaming parser and cancels the unused facet dictionary.

`/api/shiur-views?ids=…` accepts up to 24 IDs. Visible recordings share a browser request queue and deduplicate IDs. The server limits concurrent upstream reads to six across batches and detail requests. Successful counters are cached for five minutes in bounded browser and server caches. Missing source records are cached for one minute. Failed browser lookups stay hidden for one minute and can retry on a later visit. Existing search/trending snapshots retain their own cache periods.

`/api/shiur` also retrieves an omitted count, so direct shiur links include it. Counter lookup failures do not fail the detail response. Opening details from a search result retains its previous count if the fresh response has none.

These totals come from YUTorah's public search index and may lag the official lecture page. Local plays do not add to or estimate the official counter.

Run `npm run test:api` for count normalization, display, ID validation, exact result matching, streaming cancellation, caching, request deduplication, bounded concurrency, outage recovery, and detail-link coverage. The learning suite verifies existing popularity ranking behavior.
