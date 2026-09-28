# Provision and operate the Linux worker

For a first installation, follow [the ordered setup checklist](transcription-setup.md).

Read [the architecture report](transcription-architecture.md) for the Lectern code
trace and research limitations. The website's D1 metadata cache remains separate
from the PostgreSQL transcript store. The Linux worker now polls the public YU Torah
catalog, and the website search view queries completed transcripts through a
read-only VM service. Deployment and account sign-in still require an operator.

## Fresh VM

Use Linux x86-64 or ARM64 with Node 22.13+ (tested here with Node 24.20.0), FFmpeg,
PostgreSQL 15+, and several GB of free disk for concurrent runtime extraction/audio.
There is no GPU or local speech model. Start with concurrency 1 on a very small VM;
raise toward Lectern's default 3 after measuring peak RSS, disk, and account limits.
Do not assume free-tier capacity or continuous subscription quota.

Example Debian/Ubuntu setup (run the repository commands from `/opt/yutorah`):

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils unzip ffmpeg postgresql postgresql-contrib git caddy openssl
sudo useradd --system --create-home --home-dir /var/lib/yutorah-worker --shell /usr/sbin/nologin yutorah-worker
sudo useradd --system --no-create-home --shell /usr/sbin/nologin yutorah-search
sudo chmod 700 /var/lib/yutorah-worker
```

Install Node 22+ from [Node's official distribution](https://nodejs.org/en/download).
Verify the matching architecture archive against its release `SHASUMS256.txt`, then
install its `node`, `npm` and supporting files in `/usr/local`. The unit expects
`/usr/local/bin/node`; adjust that path if your verified installation uses another
location. Confirm `node --version` before building. Application code must be readable
by both service users but owned by the deployment user/root, not writable by either.

```sh
cd /opt/yutorah
npm ci
npm run worker:build
sudo bash deploy/transcription/install-runtime.sh
sudo -u postgres createuser yutorah-worker
sudo -u postgres createdb --owner=yutorah-worker yutorah_transcription
sudo install -m 0640 -o root -g yutorah-worker deploy/transcription/worker.env.example /etc/yutorah-worker.env
```

The example uses PostgreSQL's local Unix socket and peer authentication: the OS user
`yutorah-worker` owns a dedicated database. Check `pg_hba.conf` permits local peer
auth; do not expose PostgreSQL publicly. For a managed database, set `DATABASE_URL`
in the private environment file and require certificate-verified TLS. Never use
`rejectUnauthorized:false`. Run migrations as the database owner; use a separate
read-only database role for the search process.

For commands below, load the controlled environment file as the service user:

```sh
sudo -u yutorah-worker bash -ec 'set -a; source /etc/yutorah-worker.env; set +a; cd /opt/yutorah; /usr/local/bin/node .worker-build/apps/worker/src/cli.js migrate'
sudo -u yutorah-worker bash -ec 'set -a; source /etc/yutorah-worker.env; set +a; cd /opt/yutorah; /usr/local/bin/node .worker-build/apps/worker/src/cli.js probe'
```

`migrate` applies the numbered SQL files in order, serializes itself, and records
applied DDL transactionally. `probe` checks the
expected runtime identity, protocol, native audio, and personal OAuth advertisement.
The installer validates the pinned Google archive hash and the two fixed members.
These SHA-256 values were calculated from Google's downloads, not a vendor-signed
checksum manifest. Current pins: runtime 1.2.1, both Linux architectures. The local
x86-64 handshake passed; ARM64 execution still needs a smoke test on ARM hardware.

## Personal Google sign-in over SSH

Stop the worker before sign-in. Open an interactive SSH terminal to the VM, then:

```sh
sudo -u yutorah-worker bash -ec 'set -a; source /etc/yutorah-worker.env; set +a; cd /opt/yutorah; /usr/local/bin/node .worker-build/apps/worker/src/cli.js auth'
```

The command must have a TTY. It prints the validated Google URL and selected loopback
port. Keep it running. In a **second terminal on your laptop**, run the printed
forwarding command, replacing `USER@VM` with your SSH login:

```sh
ssh -N -L PORT:127.0.0.1:PORT USER@VM
```

Open the printed Google URL in your laptop's browser. Do not change its state,
redirect URI, or query parameters. The browser callback returns through the SSH
tunnel to Google's ACP process on the VM. Port conflicts on your laptop require
restarting sign-in for a new runtime port; do not rewrite the OAuth redirect.
No firewall port needs opening. The auth command times out after five minutes.
Avoid terminal session recording and do not paste sign-in URLs into issue trackers.

Google ACP owns the token exchange, private files, and refresh. Its profile is
`/var/lib/yutorah-worker/profile`, configured through `GEMINI_HOME`, with personal
auth selected in `antigravity-acp/settings.json`. Lectern uses the same isolation
and file-storage switches. Do not extract/copy token values, call Google backend
endpoints, substitute an API key, or rely on an authenticated ordinary `agy` CLI.

Then run `auth-check` with the same command wrapper. It should authenticate without
printing a login URL and list account-advertised models. Verify the configured
model exists. Repeat `auth-check` after restarting the process and after an extended
idle period to validate persistence/renewal on the account. Expiration or revocation
surfaces `auth_required`; repeat explicit sign-in. Renewal timing is runtime-owned
and is not claimed to have been tested without account access.

## Run and inspect jobs

```sh
sudo install -m 0644 deploy/transcription/yutorah-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yutorah-worker
sudo systemctl status yutorah-worker
sudo journalctl -u yutorah-worker -f
```

The service verifies existing auth and the configured model before claiming work, polls every five seconds,
and transcribes one shiur at a time with up to `ACP_CONCURRENCY` parallel chunks.
With `CATALOG_ENABLED=true`, it checks YU Torah's small recent feed every five minutes and performs
a paginated backstop scan hourly. New audio shiurim enter the durable queue
automatically. Its cursor survives restarts, and
the next scan reaches back before the last completed pass, so a VM outage does not
silently create a three-day gap. Each page is bounded to thirty source records;
the worker never loads the full archive into memory. `sync-now` runs one immediate
bounded discovery pass. `backfill --pages 4` advances a separate persisted archive
cursor and enqueues at low priority. Repeat it to continue; do not launch a huge
archive import before measuring account quota and storage.
Its advisory database lock prevents a second active worker; the local `flock` and
systemd cgroup own process lifetime on the VM. Only one VM may actively operate
this personal profile. A distributed active/active fleet needs additional session
admission and network-partition testing.

The deployment example starts with `CATALOG_ENABLED=false` and concurrency 1 for
manual commissioning. Enqueued jobs are still processed. Enable discovery and restart
the service after validating short and long recordings. When the setting is omitted,
discovery defaults to enabled for compatibility with existing installations.

Run this block in one shell. The wrapper loads the service environment and runs
each command as `yutorah-worker` from the deployment directory:

```sh
yutorah_worker() {
  sudo -u yutorah-worker bash -ec 'set -a; source /etc/yutorah-worker.env; set +a; cd /opt/yutorah; exec /usr/local/bin/node .worker-build/apps/worker/src/cli.js "$@"' bash "$@"
}
yutorah_worker enqueue 1234567 --title 'Hilchos Shabbos' --teacher 'Rabbi X'
yutorah_worker enqueue 1234567 --audio-url https://download.yutorah.org/example.mp3 --revision updated-source --backfill
yutorah_worker sync-now
yutorah_worker backfill --pages 4
yutorah_worker status
yutorah_worker search 'חזרה'
yutorah_worker search 'Rashi' --literal
yutorah_worker cancel JOB_UUID
yutorah_worker retry JOB_UUID
```

IDs and URLs above illustrate syntax; use a real shiur. An omitted audio URL is
resolved through the YUTorah details endpoint, then the classic iframe fallback.
Downloads allow only known YUTorah/CDN hosts, validate each redirect and resolved
address, and limit time and size. The allowlist includes the exact public R2 bucket
currently reached from `shiurim.yutorah.net`; a live MP3 redirect, download, and
FFprobe inspection passed on 2026-09-24. Add a newly observed official CDN deliberately
to `packages/yutorah-core/src/media.ts` after checking it. Do not accept arbitrary
user-supplied URLs. The default ceiling is 1 GiB and 12 hours per source.

Retries preserve accepted chunks. A cancelled job stays cancelled until explicit
retry. Graceful service shutdown returns the active job to the queue. Hard crashes
leave a 90-second lease; after it expires the worker resumes. If the lease expires on the fifth or a later
claim, the job fails with `attempts_exhausted` and needs explicit `retry`.
Each accepted chunk is committed independently. Exhausted chunk retries and
policy/validation failures mark a job failed for inspection. Auth failure stops
the service; the next service start checks auth before consuming more jobs.

Failures contain only typed codes and bounded job/chunk metadata. No prompts,
audio, OAuth URLs, raw stderr, credentials, or thought text enter the worker log.
The proprietary runtime can have its own session storage inside the private
profile. Do not expose or indiscriminately archive that directory. Back up the
transcript database; protect any profile backups as credentials. Never commit
runtime state or `.env` files.

## Search service and website connection

The search process has its own OS account and a PostgreSQL role with SELECT access
only. Create that role and grant it access **after** `migrate`:

```sh
sudo -u postgres createuser yutorah-search
sudo -u postgres psql -d yutorah_transcription -c 'GRANT CONNECT ON DATABASE yutorah_transcription TO "yutorah-search"'
sudo -u postgres psql -d yutorah_transcription -c 'GRANT USAGE ON SCHEMA public TO "yutorah-search"'
sudo -u postgres psql -d yutorah_transcription -c 'GRANT SELECT ON transcription_shiurim, transcript_segments TO "yutorah-search"'
sudo install -m 0640 -o root -g yutorah-search deploy/transcription/search.env.example /etc/yutorah-search.env
sudo sh -c 'printf "TRANSCRIPT_API_TOKEN=%s\n" "$(openssl rand -hex 32)" >> /etc/yutorah-search.env'
```

Configure a DNS name for the VM, replace the hostname in
`deploy/transcription/Caddyfile.example`, and install it in `/etc/caddy/Caddyfile`.
Allow ports 80/443 for Caddy's HTTPS setup and redirects; Node binds
`127.0.0.1:8765` and PostgreSQL stays private. Restrict SSH to administrative access.
Then enable both services:

```sh
sudo install -m 0644 deploy/transcription/yutorah-search.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yutorah-search
sudo systemctl reload caddy
```

In the website's server-side deployment secrets, set `TRANSCRIPT_API_URL` to the
VM's HTTPS origin and `TRANSCRIPT_API_TOKEN` to the value in
`/etc/yutorah-search.env`. Never prefix these variables with `NEXT_PUBLIC_` or
send the token to a browser. The website's `/api/transcript-search` route forwards
bounded requests. The search view uses the same submitted query for metadata and
spoken-word results, and a transcript hit seeks the audio player to `startMs`.
If the bridge is not configured or unreachable, metadata search keeps working and
the transcript panel says so. The VM endpoint requires a bearer token, returns
short excerpts, and serves no queue mutation routes. Apply normal edge rate limits
to the public website route.

## Catalog ingestion and skill updates

The worker's automatic catalog poll calls
`TranscriptionStore.enqueue(shiur, profile, priority)`. It upserts metadata and adds
the job atomically; duplicate source/version requests are idempotent. Archive pages
use priority -10. No archive is loaded into worker memory.
`sourceRevision` distinguishes changed upstream audio at the same URL or an explicit
fresh transcription. Use `retry` for resuming an existing job.

`profile(fullSkillText, settings, runtimeIdentity)` snapshots a version once. New
skill bytes or settings create a new version. Existing queued/running jobs retain
their original skill; an upgrade does not silently mix prompt versions. To replace
them, cancel old jobs and enqueue the new version. A runtime upgrade also requires
new jobs/profile versions. Do not mutate version rows in place.

The VM search process calls `TranscriptionStore.search(query, aliases, limit, mode)`
using a PostgreSQL pool/read-only role. Default mode is normalized literal phrase;
`terms` uses PostgreSQL `simple` full-text matching. Return the original text,
matched term, alias disclosure, title, teacher, and `startMs`. The returned
`/?shiur=ID&t=SECONDS` URL matches the existing website player's seek-link format.
Render text as escaped text, never model-generated HTML. Phrase search supports up
to 16 query words, including crossings of adjacent segments. No semantic service
is involved. The initial website panel returns up to twenty results per query.

Completed transcript rows remain versioned; only the current requested job can
replace the shiur's active transcript. Search only reads active transcripts. D1
metadata search can coexist until the website's catalog architecture is decided.

## Maintenance and validation

Stop the unit, install a new verified runtime pair into a new version directory,
update both the code release pin and environment path, rebuild, run `probe` and
`auth-check`, then restart. Never replace a binary used by active processes. Old
checkpoints intentionally fail runtime/preparation/skill fingerprint checks.
Checkpoint storage lives in PostgreSQL, so deleting temporary audio is safe.
The worker removes temporary audio after each attempt and sweeps its owned scratch
directories on startup after systemd has killed the prior cgroup. `interactive/`
is reserved for manual auth/probes; after stopping those commands, it can be cleared.

Accepted checkpoints have no automatic short expiry: a long archive backlog must
retain resumability. Monitor database size. After a retention period you choose,
delete chunks for **completed** jobs in bounded batches (the final transcript is
independent). Keep failed/cancelled parts while resume is wanted; cancel/delete a
shiur through the database with care because foreign keys remove its transcripts.

```sh
npm run worker:build
npm run test:worker
# Full integration suite: point only to a disposable local PostgreSQL database.
TEST_DATABASE_URL=postgresql://USER@127.0.0.1/worker_test npm run test:worker
npx tsc --noEmit
npm run lint
```

Without `TEST_DATABASE_URL`, the PostgreSQL suite is explicitly skipped. With it,
tests create/drop isolated schemas and cover queue races, lease fencing, corruption,
atomic publication, aliases, cross-segment phrases, cancellation and SIGKILL after
seven accepted parts. The deterministic ACP fixture tests never call Google. The
audio test uses synthetic silence and FFmpeg. Before production, run a real short
shiur and a long English/Hebrew/Aramaic shiur; check coverage, boundary accuracy,
speaker handling, model availability, native-tool policy, memory, quota throttling,
and account token renewal on the target VM.
