#!/usr/bin/env bash
set -euo pipefail
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$notes_state/run.sh" status
printf 'Selected route: %s\n' "$(cat "$notes_state/route" 2>/dev/null || printf 'acp-high')"
if [[ -f "$notes_state/pools.json" ]]; then printf 'Configured pools: %s\n' "$(cat "$notes_state/pools.json")"; fi
if flock -n "$notes_state/supervisor.lock" true; then
  printf '%s\n' 'Supervisor: stopped'
else
  printf '%s\n' 'Supervisor: running'
fi
[[ ! -f "$notes_state/paused" ]] || printf '%s\n' 'Automatic restarts: paused'
tail -n 8 "$notes_state/logs/worker.log" 2>/dev/null || true
