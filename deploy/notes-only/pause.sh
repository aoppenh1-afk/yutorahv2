#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
touch "$notes_state/paused"
if [[ -f "$notes_state/supervisor.pid" ]]; then
  read -r notes_pid <"$notes_state/supervisor.pid"
  if [[ "$notes_pid" =~ ^[1-9][0-9]*$ && -r "/proc/$notes_pid/cmdline" ]]; then
    mapfile -d '' -t notes_args <"/proc/$notes_pid/cmdline"
    for notes_arg in "${notes_args[@]}"; do
      if [[ "$notes_arg" == "$notes_state/supervise.sh" ]]; then kill -TERM "$notes_pid"; break; fi
    done
  fi
fi
