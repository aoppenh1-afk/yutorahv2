#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[[ ! -f "$notes_state/paused" ]] || exit 0
exec 7>"$notes_state/start.lock"
flock -n 7 || exit 0
if ! flock -n "$notes_state/supervisor.lock" true; then exit 0; fi
# Rotate the progress log before launching; keep one previous bounded log.
if [[ -f "$notes_state/logs/worker.log" ]] &&
   [[ $(stat -c %s "$notes_state/logs/worker.log") -gt 10485760 ]]; then
  mv "$notes_state/logs/worker.log" "$notes_state/logs/worker.previous.log"
fi
nohup "$notes_state/supervise.sh" >>"$notes_state/logs/worker.log" 2>&1 < /dev/null 7>&- &
