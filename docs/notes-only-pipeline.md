# Notes-only pipeline

Implemented and tested October 9, 2026. TiDB Starter `yutorah-notes` is active
in AWS us-east-1 with a $0 spending limit. No card was added. Database
`yutorah_notes` stores compressed notes; transcripts remain on YUTorah.

## Verified pilot

Shiur 1190357 was fetched as complete public VTT, processed by the existing
Lectern notes generator through OpenCode's free model, uploaded, read back, and
displayed in the local website. Notes were 11,647 UTF-8 bytes and 4,549 gzip bytes.
The temporary transcript and ACP workspace were removed after verified publication
and a durable completion checkpoint. A compressed local notes backup remains.

The portable installer also passed a live test: a new local queue recognized the
published shiur and completed without another download or AI generation call.
The original Mac pilot generated one new shiur. The VM agent has since installed
the worker and started catalog batches; see its verification report below.

## Install on the VM

Open an agent directly on the managed VM and transfer the private
`outputs/yutorah-notes-vm-private.zip`. The archive contains a bundled Node.js
program, complete generation contracts, installer, and insert-only writer
credential. Keep the archive private. The public source package is generated
without credentials by `npm run notes:package`.

Requires Node.js 22.13 or later, git, and OpenCode 1.18.33. Use a separate
`opencode-notes` binary if the VM's default OpenCode version differs. The runtime
checks its version and confirms the exact free model and High thinking before
generation. User plugin and
agent configuration is isolated; provider state remains available to the native
runtime. No paid fallback is allowed.

From the extracted package:

```sh
bash install.sh
cd "$HOME/.local/share/yutorah-notes"
./run.sh enqueue --ids 1190357,1190833
./run.sh run --limit 2 --opencode /path/to/opencode-notes
./run.sh status
```

1190357 should be recognized as already published. Verify 1190833 on the actual
VM before starting the library import. If a quota or configuration error occurs,
the worker preserves progress and completed notes for retry. Its logs omit
credentials, prompts, and source text.

Queue catalog IDs in bounded batches, then process them:

```sh
./run.sh catalog --pages 20
./run.sh run --all --follow --opencode /path/to/opencode-notes
```

Catalog discovery saves a cursor, fetches 30 IDs per page, and waits at least one
second between pages. Run further catalog batches while the worker is stopped.
One test page reported 434,295 catalog records; this does not establish how many
have transcripts. Missing transcripts are eligible for another check after seven
days. The portable base CLI processes one job at a time. The managed VM runner adds
six concurrent jobs with pacing and shared backoff for provider or database
failures. Its installation and verification are documented in
[notes-only-vm.md](notes-only-vm.md). `status` can run while the worker is active.

All connections are outbound. SSH, a public IP, and incoming ports are unnecessary.
Keep state in the VM's persistent home directory, not its temporary runtime disk.
Install the worker in the VM service's supported startup mechanism and test a
runtime restart. A detached process alone will not restart after replacement.
The VM agent verified cron recovery after a controlled worker interruption.
Automatic recovery after a full host/runtime replacement remains unverified.

## Recovery and backups

SQLite holds IDs, status, retry times, and the catalog cursor. Temporary VTT lives
only under `jobs/<id>`. Completed notes are stored as `notes/<id>/notes.md.gz` plus
small metadata. The worker saves that backup before publication. If publication
fails or its acknowledgement is lost, it compares hashes and retries from the
backup without repeating generation. It checkpoints completion before deleting
temporary source material.

The database writer has SELECT and INSERT privileges only. Existing notes are
immutable: conflicting source, generator, or output hashes require an explicit
administrative replacement. This prevents stale retries from overwriting notes.

To restore local backups to the configured database:

```sh
./run.sh restore --limit 20
```

Copy the compressed notes and metadata to another durable location periodically.
Keep credentials separate from shared backups. TiDB's free daily backup has only
one-day retention. If an interrupted startup leaves `runner.lock` without an owner
file, verify that no notes worker is running before removing that lock directory.

## Website

The new server route `/api/study-notes?id=1190357` reads one primary-key row,
verifies and decompresses its notes, and supports ETags. Its bounded server cache
keeps completed notes for one hour and missing rows for one minute. The browser
requests notes only when Study notes is selected, caches completed notes for an
hour, and does not poll. CDN responses permit one hour of caching and one day of
stale responses during revalidation. Database credentials stay in the server.
Reader permissions allow only SELECT.

`TIDB_NOTES_HOST`, `TIDB_NOTES_USERNAME`, `TIDB_NOTES_PASSWORD`, and
`TIDB_NOTES_DATABASE` were saved as secret environment variables in Vercel's
`yutorah` project for Production and Preview. The deployed PR preview displayed
VM-generated notes for shiur 1191069. Production deployment is gated on PR checks.

Study notes load independently of the official transcript, including during
upstream transcript failures. Official summaries and quizzes are not fetched.
Searching within the loaded transcript works. This notes-only database does not
create a full-library transcript or notes search index.

## Database usage controls

A normal new job makes three targeted SQL calls: look up its shiur ID, insert
that shiur's compressed notes, and read the row back to verify publication.
Completion does not trigger a library sync, table scan, or database export.
Backups scan local compressed files and make no database calls. Already completed
jobs remain checkpointed in SQLite. Six VM workers share a cooldown after quota
or provider errors and drain active jobs before stopping new claims.

The website coalesces simultaneous requests for the same shiur and limits
concurrent uncached lookups to eight per server process. A database error creates
a one-minute cooldown shared across IDs in that process. Cached notes remain
readable. These caches and cooldowns are process-local; separate hosting instances
can each make a lookup. They reduce usage but do not cap the entire account's RUs.
The $0 database spending limit remains the billing backstop.

Regression tests count actual SDK requests for successful publication, lost
acknowledgements, concurrent readers, negative caching, and failure cooldowns.
Browser tests verify zero notes requests while reading a transcript, one on
selecting Study notes, and no repeat request when switching tabs or waiting.
The source removes a duplicate verification read after a lost acknowledgement;
an existing VM installation needs a rebuilt package to receive that optimization.

## Free capacity

Keep the Starter spending limit at $0. Exhausting storage or monthly Request Units
can interrupt work or reads; the worker backs off instead of upgrading. Free AI
availability and website hosting quotas are separate constraints.

Eight earlier notes averaged 4,011 gzip bytes, projecting approximately 1.61 GiB
of compressed payload for 430,000 notes. The new 19-minute pilot is 4,549 bytes.
These are small samples. TiDB row/index overhead and real Request Unit usage have
not been measured for a representative batch or production traffic. The 5 GiB
allowance permits about 12,485 bytes per row including overhead at that scale.

## Validation

Both website builds, TypeScript checks, worker compilation, targeted lint,
34 player browser tests, and the pipeline/ACP tests passed. The combined version
also passed six concurrency tests and a regenerated-package compatibility test. Live TiDB checks
confirmed binary gzip round trips, Hebrew checksums, duplicate publication,
conflict rejection, and privilege boundaries. The website returned HTTP 200 and
conditional HTTP 304 for the stored pilot notes. Simulated upload failure and
queue reopening verified recovery without a second AI call.
