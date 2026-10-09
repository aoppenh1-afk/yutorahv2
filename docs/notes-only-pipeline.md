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
Only one new shiur was generated; full-library processing has not started.

## Install on the VM

Open an agent directly on the managed VM and transfer the private
`outputs/yutorah-notes-vm-private.zip`. The archive contains a bundled Node.js
program, complete generation contracts, installer, and insert-only writer
credential. Keep the archive private. The public source package is generated
without credentials by `npm run notes:package`.

Requires Node.js 22.13 or later, git, and OpenCode 1.18.33. Use a separate
`opencode-notes` binary if the VM's default OpenCode version differs. The runtime
checks its version and the exact free model before generation. User plugin and
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
days. A single worker processes jobs with pacing and backoff for provider or
database failures. `status` can run while the worker is active.

All connections are outbound. SSH, a public IP, and incoming ports are unnecessary.
Keep state in the VM's persistent home directory, not its temporary runtime disk.
Install the worker in the VM service's supported startup mechanism and test a
runtime restart. A detached process alone will not restart after replacement.
The host's home persistence and startup mechanism remain to be verified on the VM.

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
keeps completed notes for five minutes and missing rows for one minute. Database
credentials stay in the server. Reader permissions allow only SELECT.

`TIDB_NOTES_HOST`, `TIDB_NOTES_USERNAME`, `TIDB_NOTES_PASSWORD`, and
`TIDB_NOTES_DATABASE` were saved as secret environment variables in Vercel's
`yutorah` project for Production and Preview. The website code has passed local
Cloudflare and Vercel builds but has not been pushed or deployed. A deployment
containing this implementation is required before those settings take effect.

Study notes load independently of the official transcript, including during
upstream transcript failures. Official summaries and quizzes are not fetched.
Searching within the loaded transcript works. This notes-only database does not
create a full-library transcript or notes search index.

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
34 player browser tests, and 15 pipeline/ACP tests passed. Live TiDB checks
confirmed binary gzip round trips, Hebrew checksums, duplicate publication,
conflict rejection, and privilege boundaries. The website returned HTTP 200 and
conditional HTTP 304 for the stored pilot notes. Simulated upload failure and
queue reopening verified recovery without a second AI call.
