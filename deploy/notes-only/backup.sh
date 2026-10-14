#!/usr/bin/env bash
set -euo pipefail
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$notes_state/run.sh" backup "$@"
