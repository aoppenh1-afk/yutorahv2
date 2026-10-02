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
budget. Each attempt gets at most six seconds, including response-body reads.
Retries repeat the exact GET URL after a timeout or recognized connection
interruption. HTTP errors, invalid JSON, and other failures still propagate.
Directory and detail reads retain their existing behavior.

[HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
permit retrying idempotent requests after communication failures.
[Node's abort signal](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay)
bounds each attempt. A monotonic deadline also accounts for time spent between
attempts, so retries cannot add another 18-second wait.

The query compiler, aliases, typo recovery, filters, caching rules, and scan
transactions remain the same. Failed reads never become empty or completed
searches. Existing source-total and duplicate checks still validate every pass.

The regression test interrupts page four of a seven-page scan and verifies all
181 candidates, filtered results, and the saved cursor. Reader tests cover
interrupted bodies, exhaustion, shared requests, the total deadline, and
permanent failures. Two direct live passes with the revised reader each returned
97 distinct candidates across four pages in about 6.4 seconds.
