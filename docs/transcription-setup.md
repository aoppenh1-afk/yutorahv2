# First deployment: operator checklist

This is the path from merged source to a running service. Use the longer
[operations guide](transcription-operations.md) for maintenance and troubleshooting.
The Git merge does not provision a VM, authenticate Google, or publish the website.

The code preserves Antigravity ACP plus the full Lectern skill. Automated tests use
an ACP fixture; an authenticated short and long transcription, token renewal, and
ARM64 execution still need validation on your account and VM.

## 1. Prepare the VM and access

Use a dedicated Debian 12/13 or Ubuntu 24.04 Linux VM. Both x86-64 and ARM64 runtime
archives are pinned; x86-64 is the architecture whose real ACP handshake was tested.
A starting allocation is 2 vCPU, 4 GB RAM, and 25 GB disk with concurrency 1. This is
an initial sizing estimate, not a measured minimum; monitor memory before increasing
concurrency. No GPU is needed. The website can stay on its existing host.

You need:

- SSH access with sudo to the VM.
- Read access to the private GitHub repository, such as an SSH deploy key.
- The personal Google account already used with Antigravity.
- A DNS hostname you control, for example `transcripts.YOUR_DOMAIN`.
- Access to the existing website deployment's server secrets and publishing flow.

Point the hostname's A record to the VM's public IPv4 address. Only add an AAAA
record if IPv6 actually reaches this VM. Allow inbound SSH from your administrative
IP and TCP ports 80/443 for Caddy. Keep PostgreSQL (5432), search (8765), and Google
OAuth callback ports closed publicly. Google's callback uses an SSH tunnel.

On the VM:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils unzip ffmpeg postgresql postgresql-contrib git caddy openssl
sudo systemctl enable --now postgresql
sudo useradd --system --create-home --home-dir /var/lib/yutorah-worker --shell /usr/sbin/nologin yutorah-worker
sudo useradd --system --no-create-home --shell /usr/sbin/nologin yutorah-search
sudo chmod 700 /var/lib/yutorah-worker
```

These account-creation commands are for a fresh VM; skip creation if the accounts
already exist. Never run the transcription service as root.

## 2. Install Node and the merged application

The following installs the Node version used for validation. It downloads from
Node's official distribution and checks the archive against its published checksum.
Run the block as your SSH user; sudo is used only for installation.

```sh
(
  set -eu
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) echo 'Unsupported architecture' >&2; exit 1 ;;
  esac
  node_archive="node-v24.20.0-linux-${node_arch}.tar.xz"
  node_stage=$(mktemp -d)
  trap 'rm -rf "$node_stage"' EXIT
  cd "$node_stage"
  curl -fsSLO "https://nodejs.org/dist/v24.20.0/$node_archive"
  curl -fsSLO https://nodejs.org/dist/v24.20.0/SHASUMS256.txt
  awk -v file="$node_archive" '$2 == file' SHASUMS256.txt > selected.sha256
  test -s selected.sha256
  sha256sum -c selected.sha256
  sudo tar -xJf "$node_archive" -C /usr/local --strip-components=1
)
/usr/local/bin/node --version
```

Configure GitHub read access for your SSH user first. Then:

```sh
sudo install -d -o "$USER" -g "$(id -gn)" -m 0755 /opt/yutorah
git clone --branch main git@github.com:aoppenh1-afk/yutorahv2.git /opt/yutorah
cd /opt/yutorah
export PATH=/usr/local/bin:$PATH
npm ci
npm run worker:build
sudo bash deploy/transcription/install-runtime.sh
```

The application directory must be readable by both service accounts and writable
only by the deployment user/root. The runtime installer intentionally refuses to
overwrite an existing installation; do not rerun it for an unchanged release.

## 3. Create the database and configure the worker

```sh
sudo -u postgres createuser yutorah-worker
sudo -u postgres createdb --owner=yutorah-worker yutorah_transcription
sudo install -m 0640 -o root -g yutorah-worker deploy/transcription/worker.env.example /etc/yutorah-worker.env
sudoedit /etc/yutorah-worker.env
```

Keep `ACP_CONCURRENCY=1` and `CATALOG_ENABLED=false` for commissioning. The provided
`DATABASE_URL` uses a local Unix socket and peer authentication; it needs no password.
Do not place OAuth credentials or the website token in Git.

Define this convenience function in your current SSH shell, and redefine it after
opening a new shell:

```sh
yutorah_worker() {
  sudo -u yutorah-worker bash -ec 'set -a; source /etc/yutorah-worker.env; set +a; cd /opt/yutorah; exec /usr/local/bin/node .worker-build/apps/worker/src/cli.js "$@"' bash "$@"
}
yutorah_worker migrate
yutorah_worker probe
```

`probe` must print `runtime_verified`. If it fails, stop here and inspect the runtime
installation, executable architecture, permissions, and service environment.

## 4. Sign in to Antigravity

Keep the worker stopped during authentication. On a first installation it has not
been enabled yet. On a previously installed VM, run `sudo systemctl stop yutorah-worker`.

In an interactive SSH terminal on the VM:

```sh
yutorah_worker auth
```

It prints a Google login URL and an SSH command containing the chosen callback port.
Keep this terminal open. In a **second terminal on your laptop**, run that command,
replacing `USER@VM` with your actual SSH login. For example, if the printed port is
34567:

```sh
ssh -N -L 34567:127.0.0.1:34567 USER@VM
```

Open the exact printed Google URL in your laptop browser and sign into your personal
Antigravity account. Do not change the URL or callback port. The callback travels
through the tunnel to Google's runtime on the VM. Once the VM reports authenticated,
stop the tunnel with Ctrl+C.

Back on the VM:

```sh
yutorah_worker auth-check
```

This must succeed without another login URL and print available model IDs. Set
`ACP_MODEL` in `/etc/yutorah-worker.env` to an advertised model you intend to use.
The current example is `gemini-3.8-flash-high`; do not assume it is available to every
account. Select the model **before enqueueing** because each job pins its settings.
Google's runtime persists and refreshes credentials under
`/var/lib/yutorah-worker/profile`; no manual token extraction is needed.

## 5. Transcribe one recording, then test restart and a longer recording

Choose a real short audio shiur and take its numeric ID from YU Torah. Replace the
example ID below; it is not a test recording supplied by this repository.

```sh
yutorah_worker enqueue 1234567 --title 'My short validation shiur' --teacher 'Rabbi Name'
sudo install -m 0644 deploy/transcription/yutorah-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yutorah-worker
sudo journalctl -u yutorah-worker -f
```

Wait for the `completed` event for the returned job ID. Ctrl+C stops journal viewing,
not the worker. Inspect the result:

```sh
yutorah_worker status
yutorah_worker search 'חזרה'
```

Use a word actually spoken in your recording. Check Hebrew/Aramaic spelling,
coverage, speaker labels, and several timestamps against the audio. Then enqueue
a longer mixed-language shiur. During that job, restart the service:

```sh
sudo systemctl restart yutorah-worker
```

Previously accepted chunks should remain reusable. After completion, inspect chunk
counts and original acceptance times if needed:

```sh
sudo -u postgres psql -d yutorah_transcription -c 'SELECT job_id,count(*),min(accepted_at),max(accepted_at) FROM transcription_chunks GROUP BY job_id;'
```

A failed job retains its successful chunks. Inspect `status` and the service log;
fix the cause before `yutorah_worker retry JOB_UUID`. Do not enable archive backfill
until a long recording has passed. Stop the worker before repeating `auth-check`
after an idle period, then restart it; this validates credential persistence on your
account without running a second interactive runtime alongside transcription.

## 6. Start transcript search and HTTPS

Create the database reader after migrations:

```sh
sudo -u postgres createuser yutorah-search
sudo -u postgres psql -d yutorah_transcription -c 'GRANT CONNECT ON DATABASE yutorah_transcription TO "yutorah-search"'
sudo -u postgres psql -d yutorah_transcription -c 'GRANT USAGE ON SCHEMA public TO "yutorah-search"'
sudo -u postgres psql -d yutorah_transcription -c 'GRANT SELECT ON transcription_shiurim, transcript_segments, transcript_search_words TO "yutorah-search"'
sudo install -m 0640 -o root -g yutorah-search deploy/transcription/search.env.example /etc/yutorah-search.env
sudo sh -c 'printf "TRANSCRIPT_API_TOKEN=%s\n" "$(openssl rand -hex 32)" >> /etc/yutorah-search.env'
sudo install -m 0644 deploy/transcription/yutorah-search.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yutorah-search
```

Generate the token once. Replacing it later requires updating the website secret and
restarting search. Open `/etc/yutorah-search.env` privately to copy it; do not send it
in chat or save it in shell history.

Add this block to `/etc/caddy/Caddyfile`, replacing the hostname. Preserve any other
sites already configured on the VM:

```caddyfile
transcripts.YOUR_DOMAIN {
    reverse_proxy 127.0.0.1:8765
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Caddy obtains HTTPS certificates when DNS and ports 80/443 are reachable; see its
[official HTTPS requirements](https://caddyserver.com/docs/automatic-https).
An unauthenticated `curl -i https://transcripts.YOUR_DOMAIN/health` should return
**401**. That confirms the endpoint is reachable and rejects missing credentials.

## 7. Connect and publish the existing website

Set these **server-side runtime settings** on the existing website deployment:

| Name                   | Value                                              |
| ---------------------- | -------------------------------------------------- |
| `TRANSCRIPT_API_URL`   | `https://transcripts.YOUR_DOMAIN`                  |
| `TRANSCRIPT_API_TOKEN` | The generated token from `/etc/yutorah-search.env` |

For a Cloudflare Worker you manage directly, use Workers & Pages → your existing
Worker → Settings → Variables and Secrets. Add the token as a Secret and the URL
as a variable, then deploy the change. See
[Cloudflare's secret instructions](https://developers.cloudflare.com/workers/configuration/secrets/).
This repository's `nodejs_compat` configuration exposes runtime values to the route.

If the website is managed through Sites, use that existing project's server-secret
and publishing facilities. The repository identifies project
`appgprj_6a9f1a5e1eb08191985f347619864022`. Do not create a replacement project to work
around missing access. Previous QA recorded an access problem with that project;
restore access or identify the actual hosting account before publishing. Host-specific
secret controls for that managed project have not been validated in this review.

Deploy the merged website source through its existing pipeline and apply its D1
migrations. D1 continues to serve metadata search; the VM's PostgreSQL stores
transcripts. Merging this PR alone does not publish the website or set either secret.

Search for a phrase from your completed recording. Confirm that the transcript panel
shows it, clicking it seeks to the expected timestamp, and opening the result in a
new tab preserves the timestamp. Test at least one English and one Hebrew query.
Configure an edge rate limit for `/api/transcript-search` in your website hosting
account before opening it to substantial public traffic.

## 8. Enable continuous ingestion and maintain the service

After the end-to-end tests pass, edit `/etc/yutorah-worker.env` and change
`CATALOG_ENABLED=false` to `CATALOG_ENABLED=true`, then:

```sh
sudo systemctl restart yutorah-worker
sudo systemctl is-active yutorah-worker yutorah-search caddy
```

New audio is discovered automatically. Keep concurrency 1 initially; raise it toward
3 only after observing memory, processing time, and account quota. Backfill is an
explicit operation: `yutorah_worker backfill --pages 4` adds a small archive batch.
Repeat only as capacity permits.

Enable daily PostgreSQL backups, copy them off the VM with restricted access, and
practice restoring into a separate database. For a manual snapshot outside Git:

```sh
umask 077
sudo -u postgres pg_dump -Fc yutorah_transcription > "$HOME/yutorah-transcription.dump"
pg_restore --list "$HOME/yutorah-transcription.dump" > /dev/null
```

The listing check does not replace a restore rehearsal. Protect any profile backup
as a credential; reauthentication is also possible if the profile is lost. Monitor
free disk, failed jobs, repeated service restarts, and absence of new completions.
Source audio is temporary; transcripts and checkpoints live in PostgreSQL.
