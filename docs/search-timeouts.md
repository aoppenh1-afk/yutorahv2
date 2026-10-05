# Search read timeouts

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
