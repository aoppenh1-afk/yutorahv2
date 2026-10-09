#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export NOTES_ASSET_ROOT="$notes_state/app"
exec node "$notes_state/app/notes-pipeline.mjs" "$@" --state "$notes_state"
