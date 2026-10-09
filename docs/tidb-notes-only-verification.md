# TiDB notes-only verification

Verified October 9, 2026. The implementation and one real end-to-end pilot
succeeded. The live VM installation, host startup recovery, representative
storage/RU measurement, and production website deployment remain outstanding.
Operational instructions are in [notes-only-pipeline.md](notes-only-pipeline.md).

## Live evidence

- Created free TiDB Starter instance `yutorah-notes` in AWS us-east-1 under
  project `yutorah`. Selected a $0 spending limit. No card or paid upgrade was
  added. The active instance overview showed Current Spend Free.
- Executed `db/tidb-notes/001_notes.sql` against database `yutorah_notes` using
  the pinned official `@tidbcloud/serverless` 0.3.0 HTTP driver.
- Created separate SELECT-only website and SELECT/INSERT-only worker users.
  Live checks rejected reader DELETE and writer UPDATE operations.
- Fetched the complete public VTT for shiur 1190357 without authentication:
  254 cues. Generated notes through OpenCode 1.18.33 and the pinned
  `opencode/muse-spark-1.3-contributor-free` model, using the existing Lectern
  generation contracts.
- Stored 11,647 UTF-8 bytes as 4,549 gzip bytes. Read the binary blob back from
  TiDB, decompressed it, and matched its SHA-256, including Hebrew text.
- Duplicate publication succeeded without another row. Conflicting generator
  metadata was rejected. Temporary source VTT was deleted only after verified
  publication and durable local completion. Compressed notes backup remains.
- A simulated upload failure and reopened SQLite queue resumed from the backup
  without a second fetch or generation. A separate portable installation also
  recognized the live published row and skipped AI entirely.
- Local Cloudflare website `/api/study-notes` returned the complete notes with
  HTTP 200 and HTTP 304 for a matching ETag. The Chrome extension confirmed
  Study notes rendered in the website.
- Both website builds, TypeScript checks, worker compilation, targeted lint,
  34 player tests, and 15 pipeline/ACP tests passed. Reader tests include notes
  remaining readable when the official transcript request fails.
- Saved all four server-only TiDB reader environment variables in Vercel's
  `yutorah` project for Production and Preview. New code has not been deployed.
- One catalog discovery page returned 30 records and a reported total of
  434,295. The count of available transcripts remains unknown. Bulk generation
  has not started.

Private local evidence and credentials are under Git-ignored `work/tidb-setup`.
Credentials are separate from public documentation and source. The VM transfer
archive contains only its restricted writer credential.

## Capacity and billing

Eight earlier notes averaged 4,010.75 gzip bytes, projecting 1.606 GiB of payload
for 430,000 notes. Adding an assumed 512 bytes per row gives 1.811 GiB; that
row overhead is a scenario, not a TiDB measurement. The new pilot is 4,549 bytes
for a 19-minute shiur and does not replace a representative sample. At 430,000
rows, 5 GiB allows an average of about 12,485 bytes including metadata and indexes.
Application gzip stores one binary compressed copy rather than plaintext or base64.

[Starter quotas](https://docs.pingcap.com/tidbcloud/serverless-limitations/) include
5 GiB row storage and 50 million Request Units monthly per qualifying instance.
The separate columnar quota is an analytical replica, not additional capacity
for distinct notes. [Request Units](https://www.pingcap.com/tidb-cloud-starter-pricing-details/)
cover SQL CPU, storage I/O, and egress; they are not an API-call count.

Keep the [spending limit](https://docs.pingcap.com/tidbcloud/tidb-cloud-glossary/#spending-limit)
at zero. Exhaustion can interrupt database access rather than incur charges.
Actual table/index storage and instance RUs including egress/background usage
remain unmeasured for a representative batch or production traffic. Free AI and
website hosting quotas are separate. This evidence supports the design, not an
uninterrupted free service guarantee for the entire library.

## Recovery limits

The worker uses persistent-home SQLite, durable compressed notes backups,
insert-only publication, confirmed hashes, and deletion after completion. One
worker paces requests and backs off on provider/database failures. Website reads
use primary-key queries, a bounded cache, and no AI calls.

The VM has no incoming network access and does not need it. Its reported home
persistence and 100 GB disk capacity require verification there. A service startup
hook must be installed and tested: persistent files alone do not restart processes.
TiDB provides [daily free backups with one-day retention](https://docs.pingcap.com/tidbcloud/backup-and-restore-serverless/);
keep independent compressed notes backups and test restoration.

Deleting transcripts means older source text cannot be recovered if YUTorah removes
or changes it. Saved notes remain readable. Search within a loaded live transcript
works; full-library transcript/notes search requires a separate index and capacity
test. This implementation does not store that index.
