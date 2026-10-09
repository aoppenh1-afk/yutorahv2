#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec 6>"$notes_state/backup.lock"
flock -n 6 || exit 0
exec "$notes_state/bin/node" "$notes_state/backup.mjs" "$notes_state" \
  /home/box/.local/share/yutorah-notes-backup/notes
