# First deployment: operator checklist

Use [the operator guide](transcription-operator.md) for the GUI, selection rules,
notes pipeline, and troubleshooting. This checklist installs the same GUI and
read-only content service on a new VM. Merging code does not connect Google or
publish the existing website.

## 1. Prepare the VM

Use Debian/Ubuntu Linux x86-64 or ARM64, Node >=22.13, PostgreSQL >=15, FFmpeg,
curl, unzip, and OpenSSL. Node 24.20.0 and PostgreSQL 17 were tested. The real
native handshake passed on x86-64; ARM64 still needs its own commissioning check.
For Oracle Cloud, first read [the Oracle VM notes](transcription-oracle.md) to
identify the architecture and configure SSH/network access.

Install the OS dependencies and ensure PostgreSQL is running:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl unzip ffmpeg postgresql postgresql-contrib git openssl
sudo systemctl enable --now postgresql
```

On a container without systemd, use its PostgreSQL startup command instead.
Install a current Node release from [Node's official distribution](https://nodejs.org/en/download),
verifying the matching architecture archive against its release checksums.
Confirm `node --version` before building.

## 2. Build and install

Configure GitHub read access for your SSH user, then build the merged source:

```sh
git clone --branch main git@github.com:aoppenh1-afk/yutorahv2.git yutorahv2
cd yutorahv2
npm ci
npm run worker:build
sudo bash deploy/transcription/install-runtime.sh
sudo env OPERATOR_NODE="$(command -v node)" bash deploy/transcription/install-operator.sh
```

The installer creates the dedicated service accounts/database, applies all
migrations, installs the app at `/opt/yutorah-operator`, and starts the private
operator on port 8766 and read-only content on port 8765. Both bind loopback.
It creates separate private environment files for each service; preserve these,
the Google profile, and the database when upgrading. The installer refuses an
existing installation; upgrade instructions are in the operator guide.

Before sign-in, verify the native runtime under the actual service account:

```sh
sudo -u yutorah-worker bash -ec 'set -a; source /etc/yutorah-operator.env; set +a; cd /opt/yutorah-operator; exec ./bin/node .worker-build/apps/worker/src/cli.js probe'
```

Expect `runtime_verified`. Inspect installation, architecture, and permissions if
it fails. The runtime download and both fixed binary members are hash-pinned.

## 3. Connect Google and choose a small batch

Open an SSH tunnel from your laptop:

```sh
ssh -N -L 8766:127.0.0.1:8766 USER@VM
```

Open `http://127.0.0.1:8766`; the workspace opens without a password.
Click **Connect Google**, run the separate callback tunnel the GUI displays, and open its exact
Google URL. After sign-in, stop that callback tunnel and select an advertised
model. **Check saved sign-in** verifies persisted credentials without a login URL.

Pick teachers or series, optionally narrow a series to one teacher, and set a
small total recording budget (default 10 per selection). Suggested directory
entries are Rabbi Aryeh Lebowitz (80714) and Ten Minute Halacha (4233). The series
includes other teachers, so restrict it to 80714 if that is your intended scope.
Enable only your intended selections, import the batch, then **Start queue**.
The worker verifies auth/model before any claim or audio download.

## 4. Commission the complete flow

Start with one short recording. Use **Read** to inspect its timed transcript
and generated outline. Check Hebrew/Aramaic spelling, coverage, and timestamps
against the audio. Then try a longer shiur and pause/restart the queue mid-job.
Accepted chunks and cleaned text should be reused. Downloaded audio should be
removed after each attempt. Retry failed transcript and notes jobs independently.

Automated checks cover storage, scope, leases, retries, cancellation, notes, and
website/search integration using a deterministic provider fixture. Real model
quality, account quota, and credential renewal require your Google account.
For manual CLI commissioning, stop the GUI worker and run an explicitly enqueued
recording with `run --unscoped`; the default worker accepts selected jobs only.

## 5. Connect and publish the existing website

For a short pilot, install Cloudflare's `cloudflared` binary at
`/opt/yutorah-operator/bin/cloudflared`, start the existing content service, then
run `sudo bash deploy/transcription/start-content-tunnel.sh`. It runs as the
read-only service user and forwards only `127.0.0.1:8765`. The operator on port
8766 stays private. Requests still require the read-service token.

Use the returned HTTPS address as `TRANSCRIPT_API_URL` and store
`TRANSCRIPT_API_TOKEN` as a **secret** on the existing Sites project. Publish the
merged website while preserving its current audience. The pilot tunnel's PID,
address, and log are in `/run/yutorah-content-tunnel.pid`,
`/run/yutorah-content-tunnel-url`, and `/var/log/yutorah-content-tunnel.log`.
Running the script again preserves an active tunnel. A VM or tunnel restart
changes the address: update the website setting and redeploy a saved version.
The launcher records the Linux process start time in
`/run/yutorah-content-tunnel.start` and verifies the command before reusing a PID.
If startup times out, rerunning it waits for the existing tunnel's address;
it reports success only after recording that address.
Quick tunnels are temporary; use a named tunnel or the DNS/TLS setup below for
a permanent connection.

Point a DNS name at the VM and put the read-only endpoint behind HTTPS. For
example, add this to the VM's existing Caddy configuration:

```caddyfile
transcripts.YOUR_DOMAIN {
    reverse_proxy 127.0.0.1:8765
}
```

Validate/reload Caddy and allow its HTTPS ports. See
[Caddy's HTTPS requirements](https://caddyserver.com/docs/automatic-https).
Leave the operator private. An unauthenticated request to the deployed `/health`
should return 401.

Set these server-side settings on the existing website deployment:

| Name | Value |
| --- | --- |
| `TRANSCRIPT_API_URL` | `https://transcripts.YOUR_DOMAIN` |
| `TRANSCRIPT_API_TOKEN` | The token from `/etc/yutorah-search.env` |

Use the existing host's secret facilities, such as
[Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
Never expose either token as a browser variable. If using the previously managed
Sites project, restore that project's access rather than creating a replacement.
Deploy the merged website and apply its D1 migrations through its existing
pipeline. Its metadata cache remains separate from PostgreSQL transcripts.

Open the completed shiur and verify the transcript and generated notes. Search
English/Hebrew words spoken in it, including a typo, and check that transcript
hits and reader timestamps seek to the correct audio position. The search from
main remains the matching implementation.

## 6. Operate within the chosen scope

Raise a selection's total budget to add more recordings. Automatic polling stops
at that budget; it never discovers the whole archive. The VM app defaults to
five shared Antigravity sessions across recordings, chunks, and notes. Change
`ACP_CONCURRENCY` and restart to adjust this limit for the VM/account.
Pause a selection to prevent future discovery/claims from that source.

On systemd VMs, use `systemctl`/`journalctl` for `yutorah-operator` and
`yutorah-content`. The development container has background processes instead;
its restart command is in the operator guide. Run only one worker owner.
Back up PostgreSQL off the VM and rehearse a restore. Google profile backups are
credentials. Final transcripts, notes, and resumable checkpoints live in the
database; local source audio is disposable.
