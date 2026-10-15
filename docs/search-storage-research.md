# Search and transcription storage investigation — 2026-10-02

## Network quota and replacement options — 2026-10-04

The transcription project reports 5,567,511,167 bytes of network transfer
against a 5,000,000,000-byte monthly allowance. Its logical storage is
172,638,208 bytes, and compute usage is 9.13 CU-hours. The titles project
has transferred 362,877,947 bytes; the retained original project has
transferred 3,556,432,337 bytes. These are separate per-project allowances.
The current billing period ends November 1. Neon suspended the transcript
compute at 2026-10-04 04:59:45 UTC, before the autocomplete release.

These totals do not identify the caller that consumed the transfer. Neon
rejects the detailed consumption-history API on Free with HTTP 403, requiring
Launch or above. Its monitoring retention is one day. The observed quota
failure is independent of the autocomplete feature and affects database
queries outside the website as well.

The code has avoidable repeated reads: the operator previously fetched the
latest 100 jobs every three seconds, and the public reader fetched the entire
transcript every ten seconds indefinitely while notes were queued. The fix
pauses both readers in hidden tabs, slows operator polling, bounds notes
polling, shares concurrent database reads, and caches successful content for
60 seconds and searches for 15 seconds. Cache sizes are bounded by entries
and UTF-8 bytes. Error and missing-content responses remain uncached.
These changes reduce future usage; they cannot replenish the exhausted
allowance or populate an empty cache while Neon is suspended.

### Options researched

Prices and quotas below were checked against official provider pages on
October 4, 2026. They exclude the website's hosting and migration labor.

| Option                                                                                                                           | Current allowance or cost                                                                                                                                                                                                                                                                          | Fit for this project                                                                                                                                                                                      | Judgment                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Neon Free / Launch](https://neon.com/docs/introduction/plans)                                                                   | Free: 5 GB transfer and 100 CU-hours per project monthly. Launch: $0.106/CU-hour, $0.35/GB-month, 500 GB transfer per project included.                                                                                                                                                            | Existing PostgreSQL schema, queue, search, and roles work as they are. At 0.25 CU continuously active for 720 hours, compute would be $19.08/project/month; actual cost depends on activity.              | Keep Free as requested. Fixing reads helps future months but does not restore this month's suspended project.                                                                                                                                                            |
| [Aiven Free](https://aiven.io/docs/products/postgresql/concepts/pg-free-tier) and [pricing](https://aiven.io/pricing/postgresql) | Free: 1 GB storage, 1 CPU, 1 GB RAM, backups, 20 connections, one free PostgreSQL service. Developer: $5/month and 8 GB storage. Pricing lists networking as included.                                                                                                                             | PostgreSQL and [pg_trgm](https://aiven.io/docs/products/postgresql/reference/list-of-extensions) preserve the existing approach. No built-in pooler on Free/Developer; cloud/region selection is limited. | Strongest managed free candidate for a small transcript database. Verify selected PostgreSQL version, role permissions, networking terms and connection concurrency before cutover. The 20-connection limit needs care with Vercel's multiple instances.                 |
| PostgreSQL on the existing worker VM                                                                                             | No additional database subscription if the VM has sufficient disk, RAM, and included transfer. [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) includes 10 TB/month outbound transfer, if that is the VM's actual hosting plan. | Reuses the existing queue and search SQL. Serve the website through its existing authenticated HTTPS reader, keeping PostgreSQL local to the VM.                                                          | Best temporary option when a current backup and VM access are available. Website reads become dependent on the VM; backups, monitoring, patching, and recovery are our responsibility. The present VM plan and available capacity were not verified from this workspace. |
| [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) for published transcripts                                         | Standard free tier: 10 GB-month, 1 million writes, 10 million reads monthly; R2 egress is free. Other connected services may bill separately.                                                                                                                                                      | Publish versioned transcript/notes JSON once and serve repeat reads from object storage/CDN. PostgreSQL still owns jobs and spoken-word search.                                                           | Best long-term way to remove full transcript downloads from the database transfer budget. This is an architectural change, not a replacement for the queue. Needs publication retries, version matching, and a way to backfill current transcripts.                      |
| [Supabase](https://supabase.com/pricing)                                                                                         | Free: 500 MB database, 5 GB uncached egress, two active projects, inactivity pause. Pro starts at $25/month, first project included, additional projects from $10/month.                                                                                                                           | PostgreSQL migration is relatively direct. The extra cached egress allowance applies to cached storage traffic, not ordinary PostgreSQL results.                                                          | Free gives little transfer headroom over Neon and less database storage. Pro is viable but does not match the current preference to avoid paid service.                                                                                                                  |
| [Cloudflare D1](https://developers.cloudflare.com/d1/platform/pricing/) / [Turso](https://turso.tech/pricing)                    | D1 Free: 5 GB total, 5 million row reads/day and 100,000 writes/day, no database egress charge. Turso Free: 5 GB storage, 500 million monthly row reads and 10 million writes.                                                                                                                     | SQLite-based storage requires replacing PostgreSQL queue locking, JSONB queries, full-text vectors, and trigram search.                                                                                   | Potential future search/read storage, but a substantial rewrite for the transcription worker. Not an emergency migration.                                                                                                                                                |
| [Railway](https://railway.com/pricing)                                                                                           | Hobby has a $5 monthly minimum credited toward resource use; service egress is $0.05/GB. Free has a $5 initial 30-day trial, then $1 monthly credit.                                                                                                                                               | PostgreSQL keeps most application code; resource use and backups require operational planning.                                                                                                            | Reasonable paid alternative. Treat credits as a trial/budget, not a permanent free database with sufficient capacity.                                                                                                                                                    |
| [Render Free PostgreSQL](https://render.com/docs/free#free-postgres)                                                             | 1 GB storage, expires after 30 days; no backups or managed pooling.                                                                                                                                                                                                                                | PostgreSQL compatibility makes a temporary restore possible.                                                                                                                                              | Avoid for this production library because it expires and would require another migration.                                                                                                                                                                                |

### Recommendation and migration constraints

Do not move all three databases merely to get a fresh allowance. The titles
project is healthy. For immediate restoration without a paid subscription,
first establish whether the VM has a current recoverable copy. If it does,
local PostgreSQL plus the existing HTTPS reader is the shortest route. Aiven
Free is the managed alternative worth evaluating with a staging restore and
load test. No provider account, subscription, database, or production
connection was changed during this research.

The October 2 split backup is a verified historical snapshot, not a verified
current copy. The live project's size has changed since then. Restoring that
snapshot alone could omit later writes. An exhausted Neon project cannot be
queried normally to export its latest data, so any immediate migration needs
a sufficiently current backup or restored source access. Preserve the source,
compare every table count and content hash, verify read-only grants and
representative search/content queries, then switch both the worker and web
reader consistently. Keep rollback copies and connection settings.

For a permanent change, I would first publish completed transcript and notes
objects to R2, retaining PostgreSQL for the transactional worker and search.
That addresses the large repeated payloads without rewriting the queue or
moving the healthy title database. Decide whether to replace Neon itself
after measuring usage with the polling/cache fix installed on both the
website and VM.

## Completed database split

The production website and operator now use two separate Neon projects:

| Project                                                                                | Data                                                                                                               | Database size immediately after restore |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------: |
| [yutorah-titles](https://console.neon.tech/app/projects/young-field-89494360)          | `yutorah_search`: archive titles, vocabulary, spelling keys, search runs and cached results                        |                              406.09 MiB |
| [yutorah-transcription](https://console.neon.tech/app/projects/withered-math-53751244) | `public`: transcription jobs, checkpoints, published transcripts, segments, notes and operator selections/settings |                               65.30 MiB |

Both are Free projects in AWS US East 1, running PostgreSQL 18.6. Vercel's
creation form advertised 1 GB per project, but queries against both new
databases returned an enforced `neon.max_cluster_size` of `512MB`. These sizes
describe the application database; other PostgreSQL databases also count
toward the project limit. Search caches and newly learned titles can grow
after restore.

The migration preserved all 22 tables. A consistent source backup was restored
into the empty destinations, then every table's row count and SHA-256 of all
rows, including generated columns, were compared in primary-key order with
UTC timestamps. All matched: 433,694 title records, 1,560,168 vocabulary rows,
83,162 spelling-key rows, 284 transcripts, 8,962 transcript segments, 399 note
records, 1,850 transcription jobs and their checkpoints/selections.

The website's Production and Preview `SEARCH_DATABASE_URL` now uses
`yutorah_search_app` in the titles project; `TRANSCRIPT_DATABASE_URL` uses
`yutorah_reader` in the transcription project. The reader has SELECT on the
six content/search tables and defaults to read-only transactions. The VM's
operator and read-only content service use the transcription project as well.
TLS connections verify the server certificate. Operator environment URLs are
shell quoted because their query parameters contain ampersands.

Production was redeployed from the existing `2e8bfa6` source revision:
[deployment](https://vercel.com/senderopp-8687s-projects/yutorah/84aaBYPHRQLNtidgBkBd4vVF39WG).
No storage-index optimization or bulk retry was included in this cutover.
The quota-aware installed worker remains in place; the capacity-classification
correction described below has not yet been installed on the VM.

Connection checks verified queue/checkpoint writes and title-index triggers
inside rolled-back transactions, reader write rejection and queue-table access
rejection, transcript searches, and exact content equality for a published
transcript with notes. The VM content service's health, transcript and search
endpoints returned HTTP 200. On the public website, transcript API content for
shiur `929649` matched the original SHA-256; its timestamped transcript and
study notes rendered. A transcript-search result opened shiur `1094570` at the
requested audio position. Transcription remains paused, with no active sessions.

All 12 live API checks passed against `https://yutorah.vercel.app`, covering the
homepage, teacher/duration filters, pagination, question interpretation, typo
and joined-word recovery, fallback search, media/source links and input errors.
The first pagination check exceeded its polling budget while the browser was
advancing the same cold search; the scan completed, its individual rerun passed,
and the complete suite then passed in 4.27 seconds. The cold, unfiltered
`tefillah` scan covered 22,770 upstream results and took about four minutes.
These searches populated disposable result caches: the titles database grew
to 452.91 MiB, with 33,302 cached hits and 433,703 learned titles. The
transcription database stayed at 65.30 MiB. Search-cache retention remains
future work; no cache data was pruned during migration.

The original `dry-water-47479286` project is retained intact for rollback.
Root-only backups, connection settings, migration scripts, table hashes and
connection-test results are under
`/var/backups/yutorah/neon-split-20261002`. Connection strings are credentials
and are deliberately omitted from this document. Rollback requires restoring
both VM environment files, switching the website's two secrets back to suitable
roles in the original project, and redeploying; rolling back a Vercel deployment
alone does not switch the VM. Preserve any new writes before rollback.

## Notes-search split on October 15

The titles project reached its enforced `512MB` limit while holding a new notes-search
index alongside the title dictionary. PostgreSQL rejected writes with SQLSTATE
`53100`. Removing disposable filtered-search caches recovered about 26 MiB, but
that left little room for new searches or notes.

An additional Neon Free project, `yutorah-search-v2`
(`wild-base-75533785`), now holds the notes-search documents, memberships,
snapshots, synchronization cursor, and lease guards. The existing titles project
keeps the title catalog, vocabulary, spelling keys, result caches, trending state,
and source sheets. Authoritative notes remain in TiDB; transcripts retain their
existing storage.

Neon's [current Free plan](https://neon.com/docs/introduction/plans) advertises
1 GB per project. Both the existing project and the newly provisioned project
returned an enforced `neon.max_cluster_size` of `512MB`, so the migration budget
uses that measured limit.

The copy was checked against every notes-index row, including the unfinished
snapshot and its synchronization state. All five table counts and ordered
content digests matched. The destination contains 7,920 indexed notes and 7,920
memberships. The authoritative TiDB store had 9,559 notes at verification time;
the search index was already incomplete before this move and retains its resume
cursor. No snapshot was marked completed by this migration.

After verifying the copy again under source-table locks, the old indexer's write
privileges were revoked and only the five relocated tables were truncated. Their
empty schema and indexes remain in the titles project for compatibility. This
recovered another 141.05 MiB. Subsequent measurements, including verification
requests, were 345.34 MiB used in the titles project and 167.16 MiB in the notes
project. That leaves roughly 167 MiB and 345 MiB free respectively.

Production and Preview now have `NOTES_SEARCH_DATABASE_URL` set to the new
`yutorah_notes_reader` connection. That role can read notes-search content and
cannot insert, update, or delete it. The local ignored `.env.notes-index.local`
uses the destination's separate `yutorah_notes_indexer` writer. The writer's
insert, update, and delete permissions were verified inside a rolled-back
transaction. The temporary development connection exposing owner credentials
was disconnected after setup.

The accompanying local code adds optional routing in `managedSearchDatabase()`.
Notes queries and their schema checks use the new connection; title search,
learning, and source processing stay together on their existing connection.
Mixed queries and transaction batches are rejected before execution. Without
the optional connection, the application retains the original single-database
behavior. The routing and capacity-error changes must be committed and pushed
before a future release, including before merging the notes-search feature.
This task did not redeploy the website. The production commit, `1791b57`, reads
published notes from TiDB and does not yet query these notes-search tables.

Post-migration production checks returned HTTP 200 for teacher `80182` search
and published notes for shiur `1191751`. Source checking returned HTTP 202 and
advanced from four to five windows, with intermittent upstream retries. Title,
vocabulary, and spelling counts remained 434,082, 1,561,925, and 83,218.

Focused routing, search, and source tests, TypeScript, and targeted lint passed.
The broader content suite includes tunnel tests that fail on this host because
passwordless `sudo` is unavailable. Database-backed routing, read permissions,
schema checks, and writer permissions were also checked against both projects.

Backups and private verification records are outside the repository under
`~/.local/share/yutorah-backups/search-capacity-20261015/`. They include the
fresh `notes-data.dump`, original schema, a notes-only restore list,
before/after digests, previous writer configuration, and grants. A complete
earlier search-schema backup was also restored successfully into a temporary
local PostgreSQL instance before the preceding cache cleanup.

Rollback requires restoring the notes data into the old empty tables first,
using `notes-only.list` so existing schema-migration history is not inserted
again. Restore the old writer grants and configuration, verify the row digests,
then remove the optional website connection and deploy the fallback routing.
Keep the destination copy intact until those checks pass. Merely removing the
environment variable or rolling back a deployment does not restore the old
index data.

## Investigation before migration

The queue is deliberately paused. This investigation does not remove live
transcripts, notes, titles, vocabulary, or search indexes.

## What filled the database

Before migration, the original managed server reported
`neon.max_cluster_size = 512MB`. A real job-update attempt failed with
PostgreSQL SQLSTATE `53100` and a message that
the project size limit has been exceeded. Google answered a separate, small
model request successfully. Database capacity was therefore a confirmed
blocker at that point; a historical generic `provider` error cannot identify its source.

The original application database occupied 489.17 MiB, with PostgreSQL's other
databases and templates bringing cluster usage to approximately 511.5 MiB.
Sizes below include each table's indexes and auxiliary storage.

| Data                                                            |       Size |
| --------------------------------------------------------------- | ---------: |
| Archive word/phrase vocabulary, including two indexes           | 220.05 MiB |
| Archive title catalog, including generated term lists           | 128.57 MiB |
| Word spelling/deletion keys and indexes                         |  60.04 MiB |
| All transcription tables, notes, jobs, checkpoints, and indexes |  61.98 MiB |
| Search result cache                                             |   9.52 MiB |

The title archive contains 433,694 titles. It expands into 83,162 individual
words, 559,667 two-word phrases, and 917,339 three-word phrases: approximately
1.56 million dictionary rows. This supports typo correction and joining or
splitting words; it is much more data than a list of recording titles.

284 final transcript texts contain only 4.17 MiB of uncompressed UTF-8 text;
399 note texts contain 2.97 MiB. The final transcript and note tables together
occupy about 4.29 MiB after PostgreSQL's compression, plus row/index overhead.
Compressing these final texts more aggressively would not solve the main problem.

The largest transcription table is `transcript_segments`, at 45.71 MiB. It
stores segment text, normalized text, neighboring text for search, two full-text
token vectors, and four indexes. The two stored token vectors alone occupy
approximately 14 MiB before table overhead. This makes transcript search much
larger than the raw text, but it still accounts for a minority of current usage.

## Measured local experiments

Experiments used a separate local database cloned from
`yutorah_search_capacity`, containing the full 433,693-title import. It differs
from the live catalog by one subsequently learned title. No experiment ran on
the managed production database.

| Experiment                                                                                                                |     Before |     After |     Saving |
| ------------------------------------------------------------------------------------------------------------------------- | ---------: | --------: | ---------: |
| Replace the compact-phrase B-tree with a PostgreSQL hash index                                                            |  81.29 MiB | 42.43 MiB |  38.86 MiB |
| Rebuild the existing compact-phrase B-tree                                                                                |  81.29 MiB | 51.75 MiB |  29.54 MiB |
| Catalog containing recording ID and original title, without repeated term lists                                           | 128.57 MiB | 43.32 MiB |  85.25 MiB |
| Dictionary retaining all words and only phrases appearing in at least two titles, with primary key and compact hash index | 220.05 MiB | 48.32 MiB | 171.73 MiB |

The hash experiment uses the exact existing expression:

```sql
CREATE INDEX research_compact_hash
ON yutorah_search.search_title_terms
USING hash ((replace(term, ' ', '')));
```

The existing phrase lookup uses equality, which hash indexes support. PostgreSQL
checks actual values after hash lookup, so a hash collision does not become a
false search match. A local `EXPLAIN (ANALYZE, BUFFERS)` confirmed an index scan
for `talmudtorah`, completing in 0.121 ms on the warm local server. This is a
single-query feasibility measurement, not a production latency guarantee.
[PostgreSQL hash index documentation](https://www.postgresql.org/docs/17/hash-index.html)
describes equality support, storage, collision rechecks, and limitations.

The catalog's `terms` field is redundant with its title and normalization rules.
Its average logical value is 198.7 bytes; the average original title is 44.4
bytes. Removing this field requires changing title-update frequency bookkeeping
and the importer, rather than simply dropping the column. A prototype SQL
term-regeneration function matched 433,692 of 433,693 stored term arrays;
the remaining normalization edge case must be resolved before migration.
PostgreSQL supports
[Unicode normalization](https://www.postgresql.org/docs/17/functions-string.html),
but locale-sensitive lowercasing and character classes need comparison with the
JavaScript matcher. A complete migration must retain title edits, deletions,
duplicate-title counting, English/Hebrew handling, and typo/word-boundary behavior.

Combining the hash index and the catalog change projects a reduction of about
124 MiB: the current application database would fall from about 489 MiB to
365 MiB, before further growth. This is an estimate formed from separately
measured local changes, not a deployed result.

The restricted-phrase experiment goes much further: 1,147,699 multiword entries
appear in exactly one title. Omitting them cuts total search storage by roughly
258 MiB when combined with the smaller catalog. However, it can lose joined-word
or split-word corrections for rare names and phrases. This is not the first
recommended change. It needs a fallback for rare phrases and explicit coverage
tests before it can preserve the existing user experience.

## Recommended order

1. Replace the compact equality index with the smaller hash index after
   benchmarking representative English, Hebrew, common, rare, and no-match
   lookups. Preserve all terms and deletion keys.
2. Stop storing generated term lists beside every title. Regenerate terms on
   title changes using the same rules, and verify dictionary counts and full
   logical content hashes against the source snapshot.
3. Address long-term growth by storing the immutable archive search dictionary
   outside the transactional transcription database, with a small database
   overlay for newly learned or changed titles. A sorted full-vocabulary TSV
   exported locally is 31.08 MiB uncompressed and 7.41 MiB with gzip. This
   demonstrates compressibility; gzip is not a query index. A practical design
   still needs a compact lookup structure, bounded server memory, hosting tests,
   and incremental-update handling.
4. Set bounded retention for disposable search-result caches and completed-job
   checkpoints. Current checkpoints occupy only 2.67 MiB, so this is housekeeping
   rather than the main fix. Preserve checkpoints for resumable jobs.
5. Revisit stored transcript search vectors and text duplication before a much
   larger transcription backlog is processed. Keep timestamp search and its
   query performance covered by representative tests.

Do not remove archive vocabulary or published transcripts merely to get the
worker running. Separating search and transcription into different projects can
isolate their capacity limits, but does not itself reduce total storage.

## Migration constraints

Production is too full to build replacement structures alongside the existing
ones. A migration must include a verified local backup, a measured space budget,
and a maintenance window or a separately provisioned destination. Recreating an
index temporarily changes lookup performance. Rewriting the catalog requires
space for the replacement and careful trigger/grant preservation.

Dropping a column does not immediately shrink the existing table file. Ordinary
`VACUUM` usually makes space reusable within tables rather than returning it;
`VACUUM FULL` rewrites tables and requires temporary space and an exclusive lock.
[PostgreSQL vacuuming documentation](https://www.postgresql.org/docs/17/routine-vacuuming.html)
explains these differences. Vacuuming the queue table succeeded but did not
resolve the storage limit.

The worker must remain paused during research and migration. Once capacity is
available, test one short failed recording, then a small batch. Do not infer
that all `invalid_transcript` failures share a cause: the older installed build
was shown to misclassify a successful plain-text quota notice as an invalid
transcript, but historical raw replies were not retained.

## Related worker correction

The worker source now classifies PostgreSQL `53100` as `storage_exhausted`,
preserves that classification when saving a chunk or renewing a lease, stops
lanes, and attempts to requeue interrupted work. The operator explains that
database storage needs attention. Focused regression tests exercise a failed
claim, a failed leased job, and a failed checkpoint save. The current installed
quota-aware build was upgraded earlier in this investigation; the additional
capacity-classification correction has not yet been installed on the VM.
