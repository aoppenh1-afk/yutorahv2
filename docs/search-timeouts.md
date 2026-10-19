# Search read timeouts

## October 19 database quota failure

The production request below consistently returned the application's HTTP 502
response in under half a second, including when repeated with the unrelated
literal query `shabbat`:

```sh
curl --fail-with-body --max-time 25 \
  'https://yutorah.vercel.app/api/search?q=rav+adler&page=1'
```

The public upstream API returned HTTP 200 with 167 results for `rav adler`.
A connection using the local search migration environment was rejected before
any SQL ran, with SQLSTATE `53000` and the message "Your account or project has
exceeded the quota." Production logs recorded only `search_failed`. These
observations point to database quota exhaustion, rather than an upstream read
timeout.

A subsequent authenticated Neon Console check confirmed the affected production
project is `yutorah-titles` (`young-field-89494360`), with endpoint
`ep-steep-dew-b8vig9u0`. Its monthly network transfer is 5,511,452,085 bytes against
a 5,000,000,000-byte allowance. Compute is 21.44 CU-hours of 100, and logical
storage is 484,466,688 bytes. The console explicitly reports exhausted network
transfer and an inactive endpoint. The current period ends November 1 at
00:00 UTC. Removing cached rows cannot replenish consumed network transfer.

The separate notes-search project has transferred only 20,620 bytes and stores
175,882,240 bytes. The older transcription project remains transfer-blocked at
5,567,511,167 bytes. These allowances are per project, so unused notes-search
capacity does not keep title search available. The October 15 split addressed
storage pressure; this incident concerns outgoing database traffic. Aggregate
usage does not identify which caller or feature consumed each byte.

Search now distinguishes that quota rejection from other resource errors,
returns an uncached HTTP 503 with a database-quota message, and records the safe
event `search_database_quota_exceeded`. It does not log connection details or
return the provider's upgrade message. `tests/search-route.test.ts` exercises
the real search route and search database-read path with the connection failure.
This response correction does not restore database access. The database quota
must be resolved separately, and the production request rerun after recovery.

## Reducing chart transfer volume

Saved chart requests previously fetched the complete shared scan state for every
chart choice, including coverage bitmaps and an independent census. Public SQL
reads now omit those private checkpoints before returning data. A process shares
the resulting snapshot for sixty seconds, rechecking rebuilding charts after
three seconds and stale completed charts after thirty seconds. Display validation
checks ranking metadata and coverage summaries; scan resumptions retain full
checkpoint validation.

Background passes also downloaded the raw checkpoint on every server restart or
new instance. New writes retain the original JSON for compatibility and add a
versioned gzip representation. Scan readers select only the compressed value in
SQL and decompress with a 16 MiB output limit. Existing uncompressed rows remain
readable. Public projections omit the compressed copy as well. The protected
runner stops immediately on an explicit database-quota rejection instead of
repeating the unavailable request. Aggregate performance samples record snapshot
read bytes and cache hits without logging IDs, queries, credentials, or content.

The regression with a large partial scan previously returned 7,167,030 serialized
database-result bytes across five chart choices. It now returns 76,428 bytes in
one SQL read. A restarted scan reads 5,459 bytes and still reconciles all 600
fixture records. These are fixture measurements, not a claim about production's
whole-month transfer savings. SQLite and real PostgreSQL regressions verify SQL
projection, compressed reads, legacy JSON preservation, and unchanged checkpoints.

## Recovery into the new account

On October 19, three Free projects were provisioned in the standalone YU Torah
organization, with 0.25 CU compute limits and AWS US East 1 placement:

- `bold-waterfall-76246199`: title search, vocabulary, and application caches.
- `square-cell-01006015`: notes-search index.
- `fancy-mode-13668947`: reserved for the legacy transcription copy.

The notes database was exported live and all five table counts and ordered
content digests matched after restore. The title recovery uses the verified
October 15 backup. All six retained title/source table counts and digests matched
that backup before ingesting recent public metadata. Expired query-cache rows and
the relocated notes-index data were excluded from the title restore; cache-byte
accounting was initialized from the actual document table. The latest schema
migration and runtime-role compatibility checks passed on the replacements.
The newest 1,500 public metadata records refreshed the recovered vocabulary.

The old title and transcription projects reject even owner connections with
SQLSTATE `53000`. The transcription destination is empty until a current source
export becomes possible; do not point the production transcript reader at it.
The original projects and backups remain intact. Account ownership transfer is
not a quota reset: [Neon's transfer documentation](https://neon.com/docs/manage/orgs-project-transfer)
states that usage follows the project and excludes Vercel-managed organizations
from direct transfers. This recovery copies data into separate new projects.

Private dumps, connection settings, ordered-copy audits, recent-title evidence,
and production-function smoke results are under
`work/neon-migration-20261019/private/`. They must remain outside Git.

## Upstream read interruptions

Production compound and misspelled searches returned HTTP 502 after roughly
18 seconds on October 2, 2026. The failing command was:

```sh
TEST_ORIGIN=https://yutorah.vercel.app node --test \
  --test-name-pattern='compound search resolves|submitted misspellings' \
  tests/live-api.test.mjs
```

Direct requests to the public YUTorah API showed intermittent stalls. The same
expanded query and page could return in 300 ms or exceed the timeout. Plain
queries also stalled. Removing a prefix wildcard or closing connections did
not reliably prevent the problem. This evidence supports interrupted upstream
reads; it does not establish the underlying network or server cause.

The search reader now allows three attempts within the original 18-second
budget. The first two attempts get at most three and five seconds; the last
attempt uses the remaining budget, including response-body reads.
Retries repeat the exact GET URL after a timeout or recognized connection
interruption or a temporary HTTP 500, 502, 503, or 504 response. Server-error
retries wait 250 then 500 ms, or the advertised `Retry-After` interval when
longer. Waiting counts toward the same deadline. An advertised wait beyond
the budget stops automatic recovery. Other HTTP errors, invalid JSON, and other
failures still propagate.
Directory and detail reads retain their existing behavior.

[HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
permit retrying idempotent requests after communication failures.
[A documented retry policy](https://docs.cloud.google.com/storage/docs/retry-strategy)
also treats these server errors as retryable for idempotent requests; applying
that policy here is a design choice based on the observed YUTorah HTTP 500.
[Node's abort signal](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay)
bounds each attempt. A monotonic deadline also accounts for time spent between
attempts, so retries cannot add another 18-second wait.

Runtime logs from deployment `67UdPssSsiFbiKhd8JADXYeHe6We` confirmed remaining
pagination, question-search, and fallback failures were upstream `TimeoutError`s.
The prayer query retrieves 22,770 candidates: one exhausted page read could
discard a four-page pass and stop the search. Both API hostnames stalled in
alternating probes; single reads also stalled, so concurrency and redirects
do not explain every failure. A later production request on deployment
`2sTokNFRc2WN1q8t3MoQyCTU7PLn` also failed with `YUTorah returned 500` during
the prayer scan. This exposed a second failure class: temporary server errors
were being treated as permanent failures and bypassing both retries and resume.

Search passes now wait for all page reads, validate every successful response,
and transactionally save the contiguous verified pages before an interrupted
read. The cursor stays at that gap, and the existing client resumes the same
run and query. Three consecutive passes without progress still return an error;
the saved run remains retryable. Other HTTP errors, changed totals, and incomplete
pages still fail the pass. Successful pages after a gap are fetched again when
the cursor reaches them.

The query compiler, aliases, typo recovery, filters, and caching rules remain the
same. Failed reads never become empty or completed searches. Existing
source-total and duplicate checks still validate completion. The live harness
allows partial passes and checks that the run, source total, and saved progress
remain consistent.

The regression test interrupts page four of a seven-page scan and verifies all
181 candidates, filtered results, and the saved cursor. Reader tests cover
interrupted bodies, exhaustion, shared requests, the total deadline, and
permanent failures. Two direct live passes with the original retry reader each
returned 97 distinct candidates across four pages in about 6.4 seconds. In two
alternating four-page probes, the six-second waits took 13 and 17 seconds, while
three/five-second waits with the remainder reserved for the final read took
3.6 and 3.7 seconds. All probes returned the same totals and complete pages;
these samples do not guarantee future latency. A regression verifies a
seven-second final response can finish within the total deadline. Additional
regressions exhaust a page's retries in strict and fallback scans, verify the
saved prefix and unchanged filters, and ensure repeated stalls stop after three
passes and can later recover.
