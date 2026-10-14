#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec 8>"$notes_state/supervisor.lock"
flock -n 8 || exit 0
notes_child= notes_stopping=0
stop_notes() { notes_stopping=1; [[ -z "$notes_child" ]] || kill -TERM "$notes_child" 2>/dev/null || true; }
trap stop_notes TERM INT
printf '%s\n' "$$" >"$notes_state/supervisor.pid"
trap 'rm -f "$notes_state/supervisor.pid"' EXIT
while [[ "$notes_stopping" == 0 && ! -f "$notes_state/paused" ]]; do
  notes_route=acp-high
  [[ ! -f "$notes_state/route" ]] || read -r notes_route <"$notes_state/route"
  notes_settings=$("$notes_state/bin/node" "$notes_state/pool-settings.mjs" "$notes_state/pools.json")
  mapfile -t notes_pools <<<"$notes_settings"
  notes_command=run
  [[ "$notes_route" != server-high ]] || notes_command=rollout
  "$notes_state/run.sh" "$notes_command" --all --follow --inventory --route "$notes_route" "${notes_pools[@]}" \
    --min-free-memory-mib 3072 --spacing-ms 2000 \
    --max-runtime-ms 21600000 --opencode /home/box/.local/bin/opencode-notes 8>&- &
  notes_child=$!
  wait "$notes_child" || true
  [[ "$notes_stopping" == 0 ]] || wait "$notes_child" 2>/dev/null || true
  notes_child=
  [[ "$notes_stopping" == 0 && ! -f "$notes_state/paused" ]] || break
  sleep 30 & notes_child=$!
  wait "$notes_child" || true
  notes_child=
done
