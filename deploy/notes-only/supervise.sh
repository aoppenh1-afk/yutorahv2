#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PATH="$notes_state/bin:/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin"
exec 8>"$notes_state/supervisor.lock"
flock -n 8 || exit 0
notes_child=
notes_stopping=0
stop_notes() {
  notes_stopping=1
  if [[ -n "$notes_child" ]]; then kill -TERM "$notes_child" 2>/dev/null || true; fi
}
trap stop_notes TERM INT
run_phase() {
  "$@" 8>&- &
  notes_child=$!
  local notes_result=0
  wait "$notes_child" || notes_result=$?
  if [[ "$notes_stopping" == 1 ]]; then
    wait "$notes_child" 2>/dev/null || true
  fi
  notes_child=
  return "$notes_result"
}
printf '%s\n' "$$" >"$notes_state/supervisor.pid"
trap 'rm -f "$notes_state/supervisor.pid"' EXIT
while [[ "$notes_stopping" == 0 && ! -f "$notes_state/paused" ]]; do
  notes_catalog_at=$(stat -c %Y "$notes_state/catalog.last" 2>/dev/null || printf '0')
  if (( $(date +%s) - notes_catalog_at >= 1800 )); then
    printf '{"phase":"catalog","at":"%s"}\n' "$(date -u +%FT%TZ)"
    if run_phase "$notes_state/run.sh" catalog --pages 20; then
      touch "$notes_state/catalog.last"
    fi
  fi
  [[ "$notes_stopping" == 0 ]] || break
  printf '{"phase":"worker","at":"%s"}\n' "$(date -u +%FT%TZ)"
  run_phase "$notes_state/run.sh" run --all --follow --concurrency 10 --max-runtime-ms 1800000 \
    --min-free-memory-mib 3072 \
    --opencode /home/box/.local/bin/opencode-notes || true
  [[ "$notes_stopping" == 0 ]] || break
  run_phase "$notes_state/backup.sh" || true
  [[ "$notes_stopping" == 0 ]] || break
  run_phase sleep 30 || true
done
