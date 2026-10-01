#!/usr/bin/env bash
set -euo pipefail
# Pilot-only HTTPS access to the authenticated, read-only service.
operator_root=${1:-/opt/yutorah-operator}
cloudflared_bin=${CLOUDFLARED_BIN:-$operator_root/bin/cloudflared}
pidfile=/run/yutorah-content-tunnel.pid
startfile=/run/yutorah-content-tunnel.start
urlfile=/run/yutorah-content-tunnel-url
logfile=/var/log/yutorah-content-tunnel.log
[ "$EUID" -eq 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
[ -x "$cloudflared_bin" ] || { echo 'Install cloudflared at the configured path first.' >&2; exit 1; }
# Serialize launchers, but let the background service release the lock.
exec 9>/run/yutorah-content-tunnel.lock
flock -x 9

read_start() {
  local stat rest
  local -a fields
  [[ "$tunnel_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  stat=$(cat "/proc/$tunnel_pid/stat" 2>/dev/null) || return 1
  # The comm field can contain spaces and parentheses; fields after its last
  # closing parenthesis start at field 3. Linux starttime is field 22.
  rest=${stat##*) }
  read -r -a fields <<< "$rest"
  [[ "${fields[0]:-}" != Z && "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
  process_start=${fields[19]}
}
tunnel_alive() {
  local first_start i
  local -a args=() expected=(-u yutorah-search -- "$cloudflared_bin" tunnel
    --no-autoupdate --url http://127.0.0.1:8765 --protocol http2)
  read_start || return 1
  first_start=$process_start
  [[ -z "$recorded_start" || "$first_start" = "$recorded_start" ]] || return 1
  mapfile -d '' -t args < "/proc/$tunnel_pid/cmdline" 2>/dev/null || return 1
  [[ ${#args[@]} -eq $((${#expected[@]} + 1)) ]] || return 1
  [[ "${args[0]##*/}" = runuser ]] || return 1
  for i in "${!expected[@]}"; do
    [[ "${args[i+1]}" = "${expected[i]}" ]] || return 1
  done
  read_start && [[ "$process_start" = "$first_start" ]]
}
tunnel_pid=$(cat "$pidfile" 2>/dev/null || true)
recorded_start=$(cat "$startfile" 2>/dev/null || true)
if tunnel_alive; then
  # Adopt an older PID-only installation only after verifying its exact command.
  recorded_start=$process_start
  printf '%s\n' "$recorded_start" > "$startfile"
else
  # Never load worker credentials, kill an unrelated PID, or forward the operator.
  : > "$urlfile"
  # Replace the inode instead of truncating a file an old process may still write.
  fresh_log=$(mktemp "${logfile}.XXXXXX")
  mv -- "$fresh_log" "$logfile"
  nohup runuser -u yutorah-search -- "$cloudflared_bin" tunnel \
    --no-autoupdate --url http://127.0.0.1:8765 --protocol http2 \
    > "$logfile" 2>&1 < /dev/null 9>&- &
  tunnel_pid=$!
  printf '%s\n' "$tunnel_pid" > "$pidfile"
  read_start || { echo "Tunnel exited; inspect $logfile." >&2; exit 1; }
  recorded_start=$process_start
  printf '%s\n' "$recorded_start" > "$startfile"
  # Allow nohup to exec runuser before checking the saved command.
  for ((attempt=0; attempt<20; attempt++)); do
    tunnel_alive && break
    sleep 0.05
  done
fi
for ((attempt=0; attempt<60; attempt++)); do
  tunnel_alive || {
    echo "Tunnel exited; inspect $logfile." >&2; exit 1;
  }
  tunnel_url=$(sed -nE 's/.*(https:\/\/[a-z-]+\.trycloudflare\.com).*/\1/p' "$logfile" | head -n 1)
  if [[ "$tunnel_url" =~ ^https://[a-z-]+\.trycloudflare\.com$ ]]; then
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
