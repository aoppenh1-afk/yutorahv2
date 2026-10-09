# Notes-only VM worker

The private package in `/workspace/yutorah-notes-vm/notes-pipeline` is installed
in `/home/box/.local/share/yutorah-notes`. Its insert-only TiDB writer credential is
mode 600 and stays outside this repository. The worker generates notes from
official public VTT; it does not download audio or generate transcripts.

Only `opencode/muse-spark-1.3-contributor-free` is allowed, through the existing
OpenCode 1.18.33 binary at `/home/box/.local/bin/opencode-notes`. There is no paid
fallback. Database/provider errors retain retryable work and back off. The TiDB
Starter spending limit remains the handoff's $0 limit; this installation makes
no billing or capacity changes.

The worker runs up to **six Muse Spark agents at once**, with one complete
transcript per job. Before every generation or repair request, ACP explicitly
sets and confirms the free model, plan mode, and **high** thinking. It stops that
request if any selection is unavailable or unconfirmed. Free slots refill
independently as jobs finish; job starts are spaced two seconds apart. A shared
cooldown stops new starts after provider/database failures while existing jobs
finish. One coordinator owns SQLite; each job has its own ACP workspace/session
and TiDB SDK connection. Already published notes are preserved.

## Verified on October 9, 2026

- Fresh shiur 1191069 generated on its first attempt at 06:15:52 UTC: 16,312 raw
  UTF-8 bytes and 6,487 gzip bytes. Independent TiDB readback decompressed to
  readable Markdown with a title, sections, and outline; it exactly matched the
  local backup and completed SQLite checkpoint. The entire temporary transcript
  and ACP job directory had been deleted. `note-verification.json` stores the
  private verification record. This verifies database readability; the website
  changes remain a separate deployment.
- At 06:17 UTC, a controlled SIGTERM interrupted six active jobs. Cron restarted
  the supervisor with a new PID and the worker resumed processing. All 73 already
  completed jobs retained their attempts and note hashes. Interrupted jobs stayed
  retryable. The pool refilled to six active jobs after restart.
- The six-agent upgrade processed a 12-job pilot: eleven new notes were published
  and one shiur lacked a transcript. Six jobs overlapped, every generation
  confirmed high thinking, and replacement jobs started while others were still
  active. Independent TiDB reads matched all eleven local backups and SQLite
  checkpoints; temporary sources were deleted. `pool-verification.json` records
  this check. The secondary backup verified all 58 completed notes afterward.
- All six pool tests and fifteen OpenCode runtime tests passed, including refusal
  of missing/unconfirmed high thinking and model changes during configuration.
  The TypeScript check, lint, formatting, shell checks, and live catalog regression
  passed. Recovery and bounded idle scheduling were rechecked after installation.
- 1190357 skipped generation because its verified published note already existed.
- 1190833 generated a new note: 31,816 UTF-8 bytes, 10,564 gzip bytes. Independent
  database reads matched the compressed local backup and completion checkpoint.
  Both pilots' temporary VTT and ACP workspaces were deleted after publication.
- Reopening the worker did not repeat completed jobs. An isolated queue with a
  simulated interrupted job and ownerless lock recovered 1190833 with
  `/bin/false` as its generator, proving that recovery did not call AI again.
- The first 20 catalog pages saved 600 unique IDs and checkpointed page 21.
  The catalog reported 434,296 records, not a count of available transcripts.
- Cron started the supervisor at 05:30 UTC. A controlled stop between jobs was
  recovered by cron at 05:32 UTC, with a new supervisor PID and the five completed
  jobs' attempts and notes hashes unchanged.
- Backup/catalog tests, the live catalog regression, targeted lint, and shell
  syntax checks passed. Private verification records are `verification.json`
  and `cron-verification.json` in the state directory.

## Runtime and scheduling

The VM's login shell resolves Node 20, which cannot run this package. The
installer copies the already-installed Node 24.20.0 into the worker's private
`bin/node`. Every operational script uses that binary explicitly; the default
Node installation and existing applications are preserved.

The public operations scripts are in `deploy/notes-only`. Reinstall only while
the notes supervisor and worker are stopped:

```sh
bash deploy/notes-only/install-vm.sh /workspace/yutorah-notes-vm/notes-pipeline
bash deploy/notes-only/install-cron.sh
```

The installer applies narrow compatibility changes to the supplied bundle.
Catalog requests use `fetch` to the fixed HTTPS public catalog endpoint, reject
redirects, and retain the 8 MiB body limit. The original media transport rejected
the managed network's DNS address `198.18.0.1`; its public-IP restrictions are
otherwise unchanged. Kernel locks serialize mutations, supervisors, and backups.
An ownerless CLI lock can be recovered only while holding the kernel mutation
lock. The supplied bundle SHA-256 is
`eae8478d6d46dab7319b50c5f9ab00f67e50518f9ec3c50281062fd2a63e04e3`.

The supervisor discovers up to 20 pages while the worker is stopped, then runs
`run --all --follow --concurrency 6 --max-runtime-ms 1800000`. The runtime limit
stops admitting jobs, drains active jobs, and bounds idle/backoff waits, so another
discovery batch can run. Bounded pilots reserve slots against `--limit`, avoiding
extra jobs beyond that limit. `--concurrency` accepts 1 through 6 and defaults to 6.
Each completed cycle verifies the second local backup, then waits 30 seconds.
Cron checks for a stopped supervisor every minute, starts it when cron starts
via `@reboot`, and runs an extra backup hourly at minute 15. Existing crontab
entries and unrelated services are retained. A `paused` file disables restarts.

Check current progress and recent outcomes:

```sh
cd /home/box/.local/share/yutorah-notes
./status.sh
./run.sh status
tail -n 20 logs/worker.log
```

To pause, create `paused`, then send SIGTERM to the PID in `supervisor.pid` after
verifying that it belongs to this directory's `supervise.sh`. The supervisor
forwards the signal to its child and waits for cleanup. Completed notes remain
saved; an interrupted generation may need another free-model call. To resume,
remove `paused` and run `./ensure-running.sh`, or wait for cron's next minute.
Stop the supervisor before manually running additional catalog batches.

## Backups and restore

The primary durable compressed copies are `notes/<id>/notes.md.gz` and
`metadata.json` under the state directory. The additional verified copy is:

```text
/home/box/.local/share/yutorah-notes-backup/notes
```

`./backup.sh` verifies decompression, length, and SHA-256 before copying. It syncs
files and directories, rejects conflicting note hashes, skips unfinished notes,
and avoids rewriting unchanged copies. It never copies credentials, transcripts,
ACP state, or prompts. `status.json` in the backup directory records the last
successful verification. This second directory is on the same VM disk, not an
off-VM backup.

To restore, copy verified note directories back under the state's `notes` folder,
then run `./run.sh restore --limit 20`. Existing identical database rows are
accepted; conflicting published notes require explicit administrative replacement.

## Limits and separate website work

This runtime uses `tini`/`pod-daemon`; systemd is offline. Cron is active and its
minute-based recovery was tested. No user-configurable host boot hook was found,
and no full runtime replacement was performed because other applications are
running. Therefore automatic startup after host replacement remains unverified.
After replacement, verify cron is running, reinstall its entries if needed, and
run the persistent `ensure-running.sh`. The host must keep the home directory
and start cron to provide unattended cold-start recovery. A suspended VM cannot
process jobs. Free-model availability and TiDB's free limits can also pause work.

The archived thread was unavailable from T3. The supplied `VM-HANDOFF.md` and
`OPERATIONS.md` define the recovered VM work. The website's `/api/study-notes`
route and Study notes reader integration are already implemented and locally
tested in the Mac checkout, as confirmed by the owner. Vercel's read-only TiDB
credentials are already configured. Those existing website changes must be
committed, pushed, and deployed separately. This VM setup does not recreate or
deploy them; its insert-only writer credential must never configure the website.

## Rechecking

Use Node 22.13+ for the tests. The live catalog regression is opt-in:

```sh
npm run test:notes-vm
NOTES_VM_RUNNER=/home/box/.local/share/yutorah-notes/run.sh npm run test:notes-vm
/home/box/.local/share/yutorah-notes/bin/node deploy/notes-only/verify-vm.mjs \
  /home/box/.local/share/yutorah-notes
```

The live VM verifier needs the supervisor stopped because it exercises mutation
locks. `verify-cron.mjs STATE` deliberately stops the supervisor at a job boundary
and waits up to 90 seconds for the installed cron entry to restart it.
With an active six-agent pool, use `verify-cron.mjs STATE --interrupt` to test a
controlled SIGTERM immediately. Active sessions are cancelled and their work
stays retryable; the verifier checks cron recovery, completed checkpoints, and
that the restarted worker actually resumes jobs. Restart recovery requires no
incoming port or SSH connection.

While the worker runs, independently verify its latest newly generated note:

```sh
/home/box/.local/share/yutorah-notes/bin/node deploy/notes-only/verify-note-vm.mjs \
  /home/box/.local/share/yutorah-notes
```

Append a numeric shiur ID to verify a specific completed job. This checks the
generation log, TiDB readback, decompressed Markdown, local backup, checkpoint,
and removal of the temporary job directory. It records only verification metadata
in the private state directory and never prints the note or transcript.

To verify a concurrent pilot with the supervisor stopped and restarts paused:

```sh
umask 077
/home/box/.local/share/yutorah-notes/run.sh run --limit 12 --concurrency 6 \
  --opencode /home/box/.local/bin/opencode-notes \
  > /home/box/.local/share/yutorah-notes/logs/pool-verification.log
/home/box/.local/share/yutorah-notes/bin/node deploy/notes-only/verify-pool-vm.mjs \
  /home/box/.local/share/yutorah-notes
```

The verifier requires six overlapping jobs and at least six generated notes,
checks automatic refill and confirmed high thinking, then independently reads
TiDB to compare each completed note with its local backup and SQLite checkpoint.
It writes the private `pool-verification.json` record. Use a larger pilot if too
many queued shiurim lack transcripts. Resume the supervisor after verification.
