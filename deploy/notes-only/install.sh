#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_package=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
notes_state=${YUTORAH_NOTES_STATE:-"$HOME/.local/share/yutorah-notes"}
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22 || (major===22 && minor<13))throw Error("Install Node.js 22.13+ first");require("node:sqlite")'
mkdir -p "$notes_state/app" "$notes_state/notes" "$notes_state/jobs" "$notes_state/logs"
chmod 700 "$notes_state"
cp "$notes_package/notes-pipeline.mjs" "$notes_state/app/notes-pipeline.mjs"
cp -R "$notes_package/packages" "$notes_state/app/"
cp "$notes_package/run.sh" "$notes_state/run.sh"
chmod 700 "$notes_state/run.sh"
if [ -f "$notes_package/writer.json" ]; then
  if [ -f "$notes_state/writer.json" ] && ! cmp -s "$notes_package/writer.json" "$notes_state/writer.json"; then
    printf '%s\n' 'An existing writer credential differs; preserve it and resolve the credential before starting.' >&2
    exit 1
  fi
  cp "$notes_package/writer.json" "$notes_state/writer.json"
  chmod 600 "$notes_state/writer.json"
fi
if [ ! -f "$notes_state/writer.json" ]; then
  printf '%s\n' 'Place the private TiDB writer.json in the persistent state directory before running.'
fi
printf 'Installed in %s\n' "$notes_state"
printf '%s\n' 'No SSH or incoming port is needed. Run ./run.sh help for commands.'
printf '%s\n' 'Start with enqueue --ids 1190357,1190833 and run --limit 2.'
printf '%s\n' 'Bulk work requires catalog discovery, then run --all --follow.'
printf '%s\n' 'After a managed-runtime replacement, rerun run.sh. Configure the VM service startup hook for automatic restart.'
