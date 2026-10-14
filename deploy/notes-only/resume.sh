#!/usr/bin/env bash
set -euo pipefail
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
rm -f "$notes_state/paused"
exec "$notes_state/ensure-running.sh"
