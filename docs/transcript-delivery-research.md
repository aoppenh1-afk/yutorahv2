# Transcript delivery on Cloudflare Free

Updated October 5, 2026. The user requires zero paid subscriptions and no
usage-based overage billing. Cloudflare Workers Free was verified in the
account dashboard. R2 was not activated and is excluded from this deployment.
Vercel currently uses Hobby.

## Decision and limits

Use D1 for public transcript content, notes, publication pointers, and transcript
search. A small authenticated Worker serves D1 to the existing website. Readers
of a verified D1 publication make no Neon requests, even on a cold CDN cache.
The website uses the D1 archive only after export and hash verification succeed.
An archive outage must not trigger automatic retries against Neon.

Workers Free permits 100,000 requests per day and 10 ms of CPU per invocation.
D1 Free permits 5 million rows read and 100,000 rows written per day, shared by
all databases in the account. It permits 500 MB per database and 5 GB total
account storage. D1 has no egress charges. Exceeding Free quotas produces errors;
it does not enable a paid upgrade. Quotas can interrupt service, and a large
import may need several days. These allowances are limits, not an availability
guarantee.

The existing `yutorah-search` D1 database consumes about 214 MB. Its data is not
modified by the transcript migration. The new `yutorah-transcript-archive`
database is separate.

Sources:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 pricing and Free-limit behavior](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 storage and SQL limits](https://developers.cloudflare.com/d1/platform/limits/)

## Implementation

The [public projection](../packages/transcription/src/store.ts) omits the unused
complete transcript string and notes-generation input from the PostgreSQL SQL
response. Internal cleanup and operator callers retain the full representation.
Public content uses a bounded one-hour process cache and a one-hour CDN cache.
Manual refresh bypasses those caches. Notes status has its own small query and
15-second cache, and does not read segment text or notes markdown.

The [reader](../app/transcript-reader.tsx) polls status while notes are pending,
stops in hidden tabs, and bounds retries. It downloads a full body after notes
complete or the active transcript changes. Failed refreshes preserve loaded
content. Vercel's `stale-if-error` can also help an existing CDN entry during an
origin failure. Cache entries remain evictable and cannot rescue a cold cache.
See [Vercel cache behavior](https://vercel.com/docs/caching/cdn-cache) and
[cache directives](https://vercel.com/docs/caching/cache-control-headers).

The [archive](../packages/transcription/src/archive.ts) stores immutable JSON
under a shiur ID and SHA-256 content hash. [D1 content chunks](../packages/transcription/src/d1-content.ts)
keep individual rows below D1's 2 MB limit and preserve exact JSON bytes,
including Hebrew and surrogate pairs. The publisher verifies uploaded bytes
before activating a newer generation. Failed or older uploads preserve the
previous live pointer. Notes-only updates reuse segment search rows.

D1 FTS5 searches normalized timed text. Phrases can cross into the next segment,
but returned seek links anchor in the matching segment. Shared Hebrew aliases
and a bounded spelling dictionary support tolerant searches. Indexing and
content hashing run on a Node host through the D1 REST API, outside the Free
Worker's 10 ms CPU limit. The Worker serves verified JSON without parsing and
serializing large transcript bodies. Its edge-cache lookup follows token
authentication; failures and missing transcripts are not cached.

The [PostgreSQL publication outbox](../db/transcription/007_publication.sql)
records transcript, notes, and correction changes transactionally. Its
[publisher](../packages/transcription/src/publication.ts) retries independently
of transcription and acknowledges only the generation it uploaded. Future
Linux workers can publish when their D1 credentials are configured. The user
currently has no VM, so no running transcription worker has been updated.

D1 replaces the public transcript delivery and search database. The existing
PostgreSQL transcription job engine still uses PostgreSQL transactions and
advisory locks. This change does not port that generation engine or provide a
new compute host. The separate title-search database also remains unchanged.

## Migration and verification

[The migration tool](../scripts/migrate-transcript-archive.ts) has four stages:
`export`, `inspect`, `import`, and `verify`. It never changes the live website.

1. Export public transcripts from a repeatable-read PostgreSQL snapshot, or the
   temporarily authenticated website export route. It writes a completed
   manifest last. IDs, timestamps, speakers, Hebrew text, and notes stay intact.
2. Inspect by constructing the complete SQLite archive locally. Reject an empty
   export or one exceeding a conservative 400 MB database budget, leaving room
   within D1's 500 MB limit. Do not upgrade the account to fit larger data.
3. Import with bounded D1 batches. Repeating an interrupted import reuses staged
   immutable rows. A row-write budget leaves capacity for other account usage;
   Cloudflare's shared Free quotas still provide the final limit.
4. Verify every transcript hash and the complete live transcript count. Only
   then configure `TRANSCRIPT_ARCHIVE_URL` and `TRANSCRIPT_ARCHIVE_READ_TOKEN`
   on Vercel and deploy. Keep the source until verification is complete.

Use a private environment file or local process environment for credentials.
Do not paste tokens into chat, commit private exports, or pass a database URL in
shell command arguments. `TRANSCRIPT_SOURCE_DATABASE_URL` supplies a direct
source. Alternatively, `TRANSCRIPT_EXPORT_URL` and `TRANSCRIPT_EXPORT_TOKEN`
authorize the temporary website export route. Remove the export token after
migration; that disables the route with a 404 response.

The archive importer and future Node publisher use
`TRANSCRIPT_ARCHIVE_ACCOUNT_ID`, `TRANSCRIPT_ARCHIVE_DATABASE_ID`, and
`TRANSCRIPT_ARCHIVE_API_TOKEN`. Use an account-scoped D1 API token on the Node
host. The public Worker has only its D1 binding and a separate read token.
Wrangler OAuth can authorize a one-time local import by supplying its private
configuration file through `TRANSCRIPT_ARCHIVE_WRANGLER_AUTH_FILE`.

## Current deployment state

The Free Worker is deployed at
`https://yutorah-transcript-archive.yutorah-study.workers.dev`.
Its D1 database ID is `c518a2b8-1eff-4924-a3f4-5e165be22054`.
The account remains on Workers Free. No R2 subscription is active.

A remote fixture verified the D1 REST batch adapter, content hashes, Worker
reading, notes status, Hebrew aliases, and spelling search. The fixture was
removed. Local tests also verify safe retry behavior, previous versions, and
cached reads requiring zero D1 queries. Browser tests verify bounded status
polling and preservation of content during an outage.

The actual existing transcript copy has not completed. The website's source
export returned 503. The signed-in Neon account shows `neon-aqua-cushion`, but
not the recorded transcript project `withered-math-53751244`. The October 2
backup was previously recorded on a VM the user no longer has. None of these
facts establishes a complete, accessible source. Do not configure the live
website to read the empty D1 archive until the original source or backup is
available and verified.
