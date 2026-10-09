#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_state=/home/box/.local/share/yutorah-notes
notes_cron=$(mktemp)
trap 'rm -f "$notes_cron"' EXIT
{ crontab -l 2>/dev/null || true; } | sed \
  '/^# BEGIN yutorah-notes$/,/^# END yutorah-notes$/d' >"$notes_cron"
cat >>"$notes_cron" <<'CRON'
# BEGIN yutorah-notes
@reboot /home/box/.local/share/yutorah-notes/ensure-running.sh
* * * * * /home/box/.local/share/yutorah-notes/ensure-running.sh
15 * * * * /home/box/.local/share/yutorah-notes/backup.sh >>/home/box/.local/share/yutorah-notes/logs/backup.log 2>&1
# END yutorah-notes
CRON
crontab "$notes_cron"
printf '%s\n' "Cron installed. State: $notes_state. The cron daemon must be running."
