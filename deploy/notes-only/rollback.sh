#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_state=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Runtime rollback keeps the v2 coordinator/schema and every newer committed artifact.
# A pre-v2 executable cannot safely open this queue. Never restore its old SQLite snapshot.
"$notes_state/pause.sh"
exec 8>"$notes_state/supervisor.lock"
flock -w 60 8 || { echo 'Worker is still draining; runtime rollback is pending.' >&2; exit 1; }
exec 9>"$notes_state/process.lock"
flock -w 60 9 || exit 1
printf '%s\n' acp-high >"$notes_state/route.next"
mv "$notes_state/route.next" "$notes_state/route"
printf '%s\n' 'Reference ACP High restored. Queue and newer artifacts retained. Run ./resume.sh after inspection.'
