#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"
operator_root=${1:-/opt/yutorah-operator}
[ "$EUID" -eq 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
# For container VMs without systemd. Credential values never appear in process arguments.
for service in operator content; do
  if [ "$service" = operator ] && [ -f "$operator_root/DEPLOYMENT_PENDING" ]; then
    echo 'operator deployment is pending; apply its migrations before starting'
    continue
  fi
  if [ "$service" = operator ]; then
    account=yutorah-worker; envfile=/etc/yutorah-operator.env; command=serve-operator
  else
    account=yutorah-search; envfile=/etc/yutorah-search.env; command=serve-search
  fi
  pidfile="/run/yutorah-$service.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$service already running"; continue
  fi
  nohup runuser -u "$account" -- bash -ec 'set -a; source "$2"; set +a; cd "$1"; exec "$1/bin/node" .worker-build/apps/worker/src/cli.js "$3"' bash "$operator_root" "$envfile" "$command" > "/var/log/yutorah-$service.log" 2>&1 < /dev/null &
  printf '%s\n' "$!" > "$pidfile"
done
