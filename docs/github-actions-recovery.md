# GitHub Actions recovery, October 24, 2026

The latest 200 workflow runs were inspected. The current recurring failures were
catalog refresh and mekoros preparation. Trending refresh passed all 44 runs in
that window, and application CI passed on the five latest commits.

Catalog refresh dropped a resource after its first failed HTTP request and
counted that failure against the entire job. The initial plan request also had
no retry. The runner now retries network errors, timeouts, throttling and
temporary server errors up to three times with backoff and Retry-After support.
Retries share the job's original deadline. Exhausted or permanent failures still
fail the job and identify the resource and HTTP status. Budget-limited scans
retain their checkpoints and report pending work.

Mekoros preparation had exhausted project storage headroom. A read-only database
measurement found 521,592,832 allocated project bytes against a 512 MiB limit.
The source creator reserves 16 MiB, so it refused new work. Its generic 503
response caused the runner to misreport that condition as upstream failure.
Preparation now checks project headroom before writing queue entries and reports
an explicit storage limit. Storage exhaustion continues to fail the job.

The existing maintenance command removed three expired completed search runs and
24,769 orphaned search documents. Standard VACUUM on the affected cache tables
reduced project allocation to 433,020,928 bytes. Published transcripts, notes,
prepared references, active leases and resumable preparation state were retained.
A live retry of previously deferred shiur 1192223 then finished with one verified
source. Scheduled preparation now runs the existing bounded cache cleanup first.
Configuration-only checks remain read-only. Cleanup now also protects active
search leases.

Published input requests now retry temporary failures before freezing the inputs
for detector checkpoints. Previously, detector retries repeatedly cloned the
same failed transcript or notes response, so recovery required another job run.

A fresh dependency audit also failed on vulnerabilities disclosed since the last
successful CI run. Vite and shadcn were updated, compatible transitive fixes were
locked, and Undici was overridden to its patched 7.30.1 release. The audit now
reports zero vulnerabilities without downgrading Cloudflare tooling.

Regression coverage includes real HTTP recovery through the catalog CLI,
persistent and authentication failures, retry budgets, preparation input
recovery, the observed project storage limit, and PostgreSQL cleanup preserving
active leases, incomplete checkpoints and trending state.
