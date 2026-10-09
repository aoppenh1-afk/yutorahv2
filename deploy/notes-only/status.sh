#!/usr/bin/env bash
set -euo pipefail
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$notes_state/run.sh" status
if flock -n "$notes_state/supervisor.lock" true; then
  printf '%s\n' 'Supervisor: stopped'
else
  printf '%s\n' 'Supervisor: running'
fi
[[ ! -f "$notes_state/paused" ]] || printf '%s\n' 'Automatic restarts: paused'
tail -n 8 "$notes_state/logs/worker.log" 2>/dev/null || true
