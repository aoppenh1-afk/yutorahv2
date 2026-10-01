# Grok / VM bot transcription controls

An installed bot with terminal access can run **`yutorah-queue`** from
any directory as its normal VM user. It talks to the same private operator as
the GUI at `http://127.0.0.1:8766`. No sudo, database credentials, or separate
Google sign-in are required when the operator is already connected. The bot
can also use the GUI through computer use on this VM.

Install on an existing VM without restarting the running worker:

```sh
sudo bash deploy/transcription/install-control.sh
```

New operator installations install the command automatically. From a checkout,
`npm run transcription -- COMMAND` also works without installing it.

## Read and manage the queue

```sh
yutorah-queue help
yutorah-queue status
yutorah-queue targets
yutorah-queue jobs
yutorah-queue directory 'Lebowitz'
yutorah-queue directory 'Ten Minute Halacha'
```

Output is JSON and errors exit nonzero. `status` shows all eligible queue totals,
settings, advertised models, and worker state. `jobs` returns the latest 100
jobs, including `id`, `shiur_id`, `notes_id`, statuses, errors, and eligibility.
Use the transcription job's `id` for transcription actions and its `notes_id`
with `--notes` for notes actions. IDs in these commands are job/selection UUIDs,
except teacher/series/shiur IDs, which are numeric upstream IDs.

```sh
yutorah-queue retry JOB_UUID
yutorah-queue cancel JOB_UUID
yutorah-queue retry NOTES_JOB_UUID --notes
yutorah-queue cancel NOTES_JOB_UUID --notes
yutorah-queue content SHIUR_ID
yutorah-queue pause
yutorah-queue start
```

Pause aborts owned sessions and retains reusable checkpoints. Pausing a source
selection instead allows already running work to finish:

```sh
yutorah-queue disable TARGET_UUID
yutorah-queue enable TARGET_UUID
yutorah-queue budget TARGET_UUID 25
```

## Set up transcription batches

Find the correct upstream ID in `directory`, then save a selection with an
explicit **total recording budget**. For example:

```sh
yutorah-queue add-teacher 80714 --limit 10
yutorah-queue add-series 4233 --limit 10 --teacher 80714
yutorah-queue scan
yutorah-queue start
```

These are examples, not a batch to add to every installation. Check `targets`
first: saving the same teacher or series updates its existing selection. A
budget of 10 means at most 10 imported jobs for that selection in total, not
10 more on each scan. Raise its budget to allow more imports. An active worker
automatically discovers enabled selections; a stopped worker can import with
`scan` before `start`. Overlapping sources share jobs for the same version.

The CLI preserves an existing series's teacher restriction when `--teacher`
is omitted, and `budget` preserves its enabled state. Explicitly changing a
series's teacher restriction resets its cursor and queue associations as in
the GUI. `scan PAGES` bounds pages per enabled selection, from 1 to 10;
its default is 2. Scan requires the operator's connected Google account and
a saved advertised model. Use the GUI's **Connect Google** or **Check saved
sign-in** if needed.

```sh
yutorah-queue model MODEL_ID
yutorah-queue notes off
yutorah-queue notes on
```

Settings changes restart an active queue and pin the new settings only for
future jobs. Existing queued/running jobs keep their pinned profiles.

This interface imports teacher/series batches. It does not enqueue an arbitrary
individual recording or upload external audio. The older worker `enqueue`
command is for manual commissioning with a separate unscoped worker; those
jobs are not eligible for the GUI worker. Use the operator selections for
routine bot work and keep a single worker owner.

## Direct HTTP access from the VM

The CLI wraps the existing localhost API; a bot can also use `curl`:

```sh
curl --fail-with-body http://127.0.0.1:8766/api/operator/status
curl --fail-with-body http://127.0.0.1:8766/api/operator/scan \
  -H 'Content-Type: application/json' -H 'X-Operator-Request: 1' \
  --data '{"pages":2}'
```

The operator accepts VM-local requests and checks the origin/host. Access
comes from the bot's existing VM access. Keep port 8766 on loopback; the public
read-only content service on 8765 has no queue controls.
