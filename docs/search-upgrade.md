# Search expansion and storage compaction

October 15, 2026. The database migration, storage reclaim, spelling-key backfill,
and public website rollout are complete at [yutorah.vercel.app](https://yutorah.vercel.app).
The [verified release](https://vercel.com/senderopp-8687s-projects/yutorah/5ZBQRwaMmsd5Y9ah13aFsiKPxSWH)
was promoted after the database preservation audit and staged search checks passed.
Production measurements are recorded below; the later fixture benchmarks remain
local measurements rather than end-to-end website latency claims.

## Search behavior

- 157 reviewed word groups cover 521 distinct spellings, including Hebrew,
  transliterations, tractates, practical halacha, and Torah terminology. Groups
  that overlap the existing dictionary merge without losing their old forms.
- 69 additional subject bridges connect everyday wording to archive terminology.
  Examples include `renting property` / `sechirus`, `free will` / `bechira
  chofshis`, and `priestly blessing` / `birkas kohanim`. These are retrieval
  alternatives, not generated answers or claims that every related word has
  exactly the same meaning.
- 25 teacher-name groups support reviewed first-name and surname spellings.
  Teacher lookup still requires an unambiguous name; initials and shared surnames
  retain their existing restrictions.
- One additional `v:` key per eligible unique word finds bounded transliteration
  candidates through the existing spelling index. It does not create keys for
  every recording. The matcher validates candidates; exact indexed wording,
  numbers, quotes, and literal searches retain their protections.
- Complete subject coverage remains the main ranking criterion. Reliable
  wording now outranks weak fuzzy title hits. Direct phrases, title coverage,
  confidence, proximity, and title density distinguish otherwise close results.
- Compiled matchers reuse expansions across fields and documents. Phrase-window
  scoring no longer repeatedly scans its current window. Directory vocabulary,
  spacing, teacher tokens, series, and topics share a cached index. Autocomplete
  uses the same concept alternatives and compiles its scorer once per request.
- Each persisted search run stores at most 32 vocabulary candidates per query
  word instead of a copy of the complete directory vocabulary. The run
  fingerprint version is 15. Its candidate query and corrections remain fixed
  through pagination and refinement.

## Storage changes

Owner migration `db/search-postgres/005_compact_vocabulary.sql` replaces the
compact-phrase B-tree with a hash index over the same equality expression. Every
term and phrase remains. PostgreSQL rechecks hash collisions. See the
[PostgreSQL hash index documentation](https://www.postgresql.org/docs/17/hash-index.html).

Normal title rows store the ID and original title, with `terms=NULL`.
`title_terms(title)` regenerates the previous list when a title changes or is
deleted. The JavaScript-supplied list remains authoritative: the insert/update
trigger removes it only when regeneration produces the identical JSON array.
Unicode or locale differences keep the original list as an exception. Stored
lists from older releases are compacted separately in bounded owner batches.

Each batch takes the existing title-writer transaction lock, locks its rows,
removes only identical lists, and verifies a logical SHA-256 before committing.
Title frequency updates skip representation-only changes. Dictionary rows,
document frequencies, deletion keys, prefix keys, and phrase coverage are not
pruned. The snapshot importer and audit understand the regenerated representation
and the additional spelling keys.

Deleting the stored lists frees space for reuse. `--reclaim` runs `VACUUM FULL`
on the title catalog to reduce its allocated file size. It requires a brief
exclusive table lock and enough temporary space for the rewrite. The command
checks the reported Neon cluster limit and uses a three-second lock timeout.
The existing website runtime role is not a migration credential.
Pending owner migrations commit together, with title writers excluded, so a
failed replay cannot leave an older trigger handling compacted null rows.

D1 keeps its existing term-list representation. Its shared matcher, ranking,
concept expansion, autocomplete, and new spelling keys receive the improvements.

## Production rollout and storage

Owner access became available through the signed-in Neon console. A consistent
40,165,878-byte custom-format database backup was saved with private permissions;
every archive entry was read back and its SHA-256 recorded before any mutation.
The website retains its existing restricted runtime credential. No second
database, paid service, or transcription database was changed.

The titles project runs PostgreSQL 18.6 and still enforces
`neon.max_cluster_size=512MB`, meaning 536,870,912 bytes. This is the measured
limit on this existing project, regardless of newer advertised plan allowances.
Measurements at 06:49 UTC on October 15:

| Physical storage | Before | After |
| --- | ---: | ---: |
| Search database, including tables and indexes | 496,885,760 bytes | 350,248,960 bytes |
| Entire PostgreSQL cluster counted against the limit | 520,339,456 bytes | 373,702,656 bytes |
| Title catalog, including indexes | 152,895,488 bytes | 61,702,144 bytes |
| Compact-phrase equality index | 54,263,808 bytes | 44,572,672 bytes |
| Unique-word spelling table, including indexes | 73,621,504 bytes | 75,120,640 bytes |

The search database fell from 473.9 MiB to 334.0 MiB, saving 139.8 MiB overall.
Project headroom rose from 15.8 MiB to 155.6 MiB. These totals include normal
search-cache cleanup as well as the requested index and catalog changes.
The current phrase index saved 9.2 MiB; the historical 39 MiB experiment used a
larger, more fragmented B-tree. The title catalog saved 87.0 MiB.

To fit the rewrite within the existing cap, maintenance removed 12 expired
search runs using the application's existing retention rules and 21,594
unreferenced cached documents. Catalog indexes were rebuilt, and the derived
autocomplete index was temporarily dropped and recreated around the catalog
rewrite. The rewrite budget used measured tuple and index sizes plus an 8 MiB
reserve. The generic compaction CLI keeps its more conservative whole-table
headroom check. The final autocomplete and phrase indexes are present and used.
An explicit `ANALYZE` after recreating the autocomplete expression index refreshed
its planner statistics. A representative 57-hit lookup then selected the GIN
index instead of filtering a backward scan of the title primary key.

All 433,949 titles remain. Compaction removed 433,948 equivalent term lists and
retained one normalization exception. Complete before/after logical SHA-256
audits matched for the titles, all 1,561,218 dictionary rows and document counts,
and all 1,473,033 original prefix/deletion keys. The backfill added 20,425 `v:`
keys, one per eligible unique word. After reclaim, the spelling table grew by
only 1.43 MiB. A real variant-key lookup and both index query plans were verified.

The remote build passed the read-only schema check using the website's runtime
connection. Nine smoke checks passed on the staged deployment and again after
promotion, covering concept autocomplete, teacher-name variants, duration
filters, joined-word correction, archive-only spelling recovery, literal guards,
and distinct pagination. Separate unauthenticated requests to the public address
also returned the expanded suggestions and ranked results. The initially empty
free-will/teacher/under-30-minutes probe was checked against the archive: all eight
matching recordings exceed 30 minutes, so its empty filtered result was correct.

Rollback deployment: `dpl_6txTgctkybzBWNTxbt1VPKBfKu98`. Current deployment:
`dpl_5ZBQRwaMmsd5Y9ah13aFsiKPxSWH`. The release source manifest, full audits,
measurements, and smoke reports are retained under the ignored directory
`work/search-upgrade-20261015/`. Its private backup remains available there.
The full backup SHA-256 is
`4ab14001d16db0f0e8ba630d5546e211b270671ad665ae8e2df98da88f0589d5`.

## Rollout

Use the existing secret-management mechanism to set
`SEARCH_MIGRATION_DATABASE_URL` to the **titles project schema owner**. Keep the
website on its restricted runtime connection. Preserve a current backup.

```sh
# Apply owner migrations before activating the new website release.
npm run search:schema:migrate

# Read-only measurements. Default invocation does not compact or add keys.
npm run search:compact

# Compact one bounded batch and inspect its numeric cursor.
npm run search:compact -- --apply --batch 500

# Finish all batches; reclaim allocated catalog space during a maintenance window.
npm run search:compact -- --apply --all --reclaim

# Add corpus-derived transliteration keys using the existing vocabulary.
npm run search:compact -- --apply --all --keys

# Verify using SEARCH_DATABASE_URL set to the restricted website runtime role.
npm run search:schema:check
```

`--after ID` resumes title compaction and `--after-word WORD` resumes key
backfill. Repeating committed batches is safe. `--schema NAME` selects an
isolated test schema. Reclaim runs before key backfill when both flags are used.
If the reclaim headroom check fails, the committed logical compaction remains
valid and reclaim can be retried later. Query caches can expire normally.

After migration, deploy the website and rerun native retrieval, typo, exact-word,
teacher ambiguity, and pagination checks. Existing titles learn new keys when
their spelling-key backfill runs; new or changed titles learn them on ingestion.
The existing `npm run search:index` command can refresh later archive titles.
No second database or paid service is required by this implementation.

To restore stored lists for older tooling, an owner can disable
`search_compact_title`, fill null lists with `title_terms(title)` in bounded
batches, and then restore `NOT NULL`. Preserve non-null exceptions. The hash
index is compatible with old equality queries and does not require reverting.
Do not reapply the original trigger definitions over compacted null rows.

## Validation

The targeted 46-query relevance corpus contains expected titles and close
distractors. The old checkout ranked an expected title first on 14/46 cases;
the new implementation did so on 46/46. The corpus focuses on the added
capabilities and is not a claim of perfect relevance across all searches.
The existing behavioral search tests also pass.

On the same host, five warmed runs produced these median local CPU measurements:

| Work | Before | After |
| --- | ---: | ---: |
| Rank 2,000 fixture documents | 47.32 ms | 25.08 ms |
| Parse 40 queries with a 1,000-teacher directory | 115.86 ms | 39.98 ms |

The isolated 20,000-title storage benchmark contains 120,613 vocabulary rows:

| Storage | Before | After |
| --- | ---: | ---: |
| Title catalog, including indexes | 9,125,888 bytes | 2,416,640 bytes |
| Vocabulary, including indexes | 33,202,176 bytes | 30,490,624 bytes |

The catalog saved 6,709,248 bytes after reclaim. The phrase index saved
2,711,552 bytes. Complete logical title and vocabulary hashes matched before
and after. `EXPLAIN ANALYZE` selected `search_title_compact_hash` for a phrase
lookup. These synthetic results do not replace a production measurement or
promise the historical 39 MiB / 85 MiB savings on the current database.

Six read-only probes against the public YUTorah API returned nonempty results
for `free will`, `renting property`, `electricity shabbat`, `mental health`,
`Baba Metsia`, and `priestly blessing`. Native queries stayed within the existing
1,800-byte encoded-query limit. These probes do not measure a complete archive
scan, database usage, or the deployed website's new behavior.

The production browser build keeps the existing 300,000-byte initial-page gzip
budget. The all-chunk budget increases from 420,000 to 425,000 bytes to account
for shared search language data; the measured Vercel build is about 423,000 bytes.
The individual-chunk and CSS budgets stay unchanged.

Reproduce the checks with a disposable PostgreSQL database:

```sh
npm run test:search
npm run test:learning
TEST_DATABASE_URL=postgresql://... npx tsx --test tests/search-compaction.test.ts tests/search-schema.test.ts tests/search-postgres.test.ts tests/search-server.test.ts tests/performance.test.ts
npm run search:evaluate -- --baseline PATH_TO_PREVIOUS_CHECKOUT --output evaluation.json
TEST_DATABASE_URL=postgresql://... npx tsx scripts/benchmark-search-storage.ts --rows 20000 --output storage.json
npm run lint
npm run build:vercel
node scripts/performance-budgets.mjs .vercel/output/static
npm run build
npm run performance:budgets
```

Additional checks cover migration restart/concurrency, read-only runtime checks,
Unicode exceptions and supplementary letters, title changes/deletions, foreign
key rollback, spelling backfill idempotence, and real SQLite FTS retrieval.
The owner CLI's dry-run, compaction, reclaim, and key-backfill paths were also
exercised against an isolated local database.

The broad content suite has six existing tunnel-launcher failures on macOS
because its Linux-oriented tests require passwordless sudo. All 43 other content
tests passed. The repository-wide TypeScript command also includes ignored
notes benchmark scripts that import a missing module; a check of tracked and new
source files passes. Neither environment issue was changed for this task.
