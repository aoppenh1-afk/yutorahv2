#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PATH="$notes_state/bin:/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin"
export NOTES_ASSET_ROOT="$notes_state/app"
case "${1:-help}" in
  help|status) exec "$notes_state/bin/node" "$notes_state/app/notes-pipeline.mjs" "$@" --state "$notes_state" ;;
esac
exec 9>"$notes_state/process.lock"
flock -n -E 75 9 || exit 75
export YUTORAH_NOTES_LOCK_HELD=1
exec "$notes_state/bin/node" "$notes_state/app/notes-pipeline.mjs" "$@" --state "$notes_state"
