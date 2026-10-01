#!/usr/bin/env bash
set -euo pipefail
# Pilot-only HTTPS access to the authenticated, read-only service.
operator_root=${1:-/opt/yutorah-operator}
cloudflared_bin=${CLOUDFLARED_BIN:-$operator_root/bin/cloudflared}
pidfile=/run/yutorah-content-tunnel.pid
urlfile=/run/yutorah-content-tunnel-url
logfile=/var/log/yutorah-content-tunnel.log
[ "$EUID" -eq 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
[ -x "$cloudflared_bin" ] || { echo 'Install cloudflared at the configured path first.' >&2; exit 1; }
if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  [ ! -f "$urlfile" ] || cat "$urlfile"
  echo 'Transcript tunnel already running.'
  exit 0
fi
# Never load worker credentials or forward the operator's port.
rm -f "$urlfile"
nohup runuser -u yutorah-search -- "$cloudflared_bin" tunnel \
  --no-autoupdate --url http://127.0.0.1:8765 --protocol http2 \
  > "$logfile" 2>&1 < /dev/null &
printf '%s\n' "$!" > "$pidfile"
for ((attempt=0; attempt<60; attempt++)); do
  kill -0 "$(cat "$pidfile")" 2>/dev/null || {
    echo "Tunnel exited; inspect $logfile." >&2; exit 1;
  }
  tunnel_url=$(sed -nE 's/.*(https:\/\/[a-z-]+\.trycloudflare\.com).*/\1/p' "$logfile" | head -n 1)
  if [ -n "$tunnel_url" ]; then
    printf '%s\n' "$tunnel_url" > "$urlfile"
    printf '%s\n' "$tunnel_url"
    echo 'Set TRANSCRIPT_API_URL on the website and redeploy its saved version.'
    echo 'A restarted quick tunnel gets a new address; update that setting again.'
    exit 0
  fi
  sleep 1
done
echo "Tunnel has not returned an address; inspect $logfile before retrying." >&2
exit 1
