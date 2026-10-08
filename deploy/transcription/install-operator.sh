#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"
# Run from a built checkout: sudo env OPERATOR_NODE=/path/to/node bash deploy/transcription/install-operator.sh
[ "$EUID" -eq 0 ] || { echo 'Run this installer with sudo.' >&2; exit 1; }
operator_root=${1:-/opt/yutorah-operator}
[[ "$operator_root" =~ ^/[a-zA-Z0-9_/-]+$ ]] || { echo 'Use an absolute installation path without spaces or shell characters.' >&2; exit 1; }
operator_node=${OPERATOR_NODE:-$(command -v node)}
[ -f .worker-build/apps/worker/src/cli.js ] || { echo 'Run npm ci and npm run worker:build first.' >&2; exit 1; }
"$operator_node" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || major===22&&minor<13) process.exit(1)'
[ ! -e "$operator_root" ] || { echo 'Installation exists. Stop the operator before deploying updated build files; credentials and database must be preserved.' >&2; exit 1; }
bash deploy/transcription/install-opencode.sh
for account in yutorah-worker yutorah-search; do
  if ! id "$account" >/dev/null 2>&1; then
    if [ "$account" = yutorah-worker ]; then
      useradd --system --user-group --create-home --home-dir /var/lib/yutorah-worker --shell /usr/sbin/nologin "$account"
    else
      useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$account"
    fi
  fi
  if [ "$(sudo -u postgres psql -tAc "SELECT count(*) FROM pg_roles WHERE rolname='$account'")" = 0 ]; then
    sudo -u postgres createuser "$account"
  fi
done
if [ "$(sudo -u postgres psql -tAc "SELECT count(*) FROM pg_database WHERE datname='yutorah_transcription'")" = 0 ]; then
  sudo -u postgres createdb --owner=yutorah-worker yutorah_transcription
fi
install -d -m 0755 "$operator_root" "$operator_root/bin" "$operator_root/db" "$operator_root/packages/transcription" "$operator_root/apps/worker" "$operator_root/deploy/transcription"
cp -a .worker-build "$operator_root/"
cp -a db/transcription "$operator_root/db/"
cp -a packages/transcription/skills "$operator_root/packages/transcription/"
cp -a apps/worker/public "$operator_root/apps/worker/"
cp package.json package-lock.json "$operator_root/"
cp -a vendor "$operator_root/"
install -m 0755 "$operator_node" "$operator_root/bin/node"
install -m 0755 deploy/transcription/start-operator.sh "$operator_root/deploy/transcription/"
install -m 0755 scripts/transcription-control.mjs /usr/local/bin/yutorah-queue
# Only JS runtime dependencies are used by the operator; build/native install hooks are unnecessary here.
PATH="$(dirname "$operator_node"):$PATH" npm ci --prefix "$operator_root" --omit=dev --ignore-scripts --no-audit --no-fund
chmod -R a+rX "$operator_root"
install -d -m 0700 -o yutorah-worker -g yutorah-worker /var/lib/yutorah-worker
if [ ! -f /etc/yutorah-operator.env ]; then
  {
    printf 'DATABASE_URL=postgresql:///yutorah_transcription?host=/var/run/postgresql\nWORKER_STATE_DIR=/var/lib/yutorah-worker\nACP_RUNTIME_DIR=/opt/antigravity-acp/1.2.1\nACP_CONCURRENCY=5\nNOTES_PROVIDER=opencode\nNOTES_CONCURRENCY=2\nOPENCODE_EXECUTABLE=/usr/local/bin/opencode-notes\nOPENCODE_VERSION=1.18.33\nCATALOG_POLL_MS=300000\nOPERATOR_PORT=8766\n'
    printf 'TRANSCRIPTION_SKILL_PATH=%s/packages/transcription/skills/lectern-transcription/SKILL.md\nNOTES_SKILL_PATH=%s/packages/transcription/skills/lectern-notes/SKILL.md\n' "$operator_root" "$operator_root"
  } > /etc/yutorah-operator.env
  chown root:yutorah-worker /etc/yutorah-operator.env; chmod 0640 /etc/yutorah-operator.env
fi
sudo -u yutorah-worker bash -ec 'set -a; source /etc/yutorah-operator.env; set +a; cd "$1"; exec "$1/bin/node" .worker-build/apps/worker/src/cli.js migrate' bash "$operator_root"
sudo -u postgres psql -d yutorah_transcription -v ON_ERROR_STOP=1 -c 'GRANT CONNECT ON DATABASE yutorah_transcription TO "yutorah-search"; GRANT USAGE ON SCHEMA public TO "yutorah-search"; GRANT SELECT ON transcription_shiurim,transcripts,transcript_segments,transcript_search_words,notes_jobs,transcript_notes TO "yutorah-search"'
if [ ! -f /etc/yutorah-search.env ]; then
  {
    printf 'DATABASE_URL=postgresql:///yutorah_transcription?host=/var/run/postgresql\nTRANSCRIPT_API_PORT=8765\n'
    printf 'TRANSCRIPT_API_TOKEN=%s\n' "$(openssl rand -hex 32)"
  } > /etc/yutorah-search.env
  chown root:yutorah-search /etc/yutorah-search.env; chmod 0640 /etc/yutorah-search.env
fi
# Pin the installed path in both units; the existing CLI worker must not run alongside the GUI's worker.
sed "s|/opt/yutorah-operator|$operator_root|g" deploy/transcription/yutorah-operator.service > /etc/systemd/system/yutorah-operator.service
sed "s|/opt/yutorah-operator|$operator_root|g" deploy/transcription/yutorah-content.service > /etc/systemd/system/yutorah-content.service
chmod 0644 /etc/systemd/system/yutorah-operator.service /etc/systemd/system/yutorah-content.service
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable --now yutorah-operator yutorah-content
else
  bash "$operator_root/deploy/transcription/start-operator.sh" "$operator_root"
  echo 'This VM has no systemd. Background services are running; use start-operator.sh again after a VM restart.'
fi
printf 'Installed password-free VM operator at http://127.0.0.1:8766 and read-only content at http://127.0.0.1:8765\n'
