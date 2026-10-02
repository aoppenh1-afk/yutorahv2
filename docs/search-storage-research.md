# Search and transcription storage investigation — 2026-10-02

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
