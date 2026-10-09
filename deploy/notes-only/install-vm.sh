#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_package=${1:?Provide the extracted private notes-pipeline directory}
notes_node=${2:-/home/box/.nvm/versions/node/v24.20.0/bin/node}
notes_state=/home/box/.local/share/yutorah-notes
notes_deploy=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$notes_node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<13))throw Error("Node 22.13+ required");require("node:sqlite")'
if [[ -f "$notes_state/supervisor.lock" ]] && ! flock -n "$notes_state/supervisor.lock" true; then
  printf '%s\n' 'Stop the notes supervisor before upgrading.' >&2; exit 1
fi
if [[ -f "$notes_state/process.lock" ]] && ! flock -n "$notes_state/process.lock" true; then
  printf '%s\n' 'Stop the notes worker before upgrading.' >&2; exit 1
fi
PATH="$(dirname "$notes_node"):$PATH" bash "$notes_package/install.sh"
mkdir -p "$notes_state/bin"
cp "$notes_node" "$notes_state/bin/node"
cp "$notes_deploy/run-vm.sh" "$notes_state/run.sh"
cp "$notes_deploy"/{supervise.sh,ensure-running.sh,status.sh,backup.sh,backup.mjs,catalog-fetch.mjs,pool.mjs} "$notes_state/"
chmod 700 "$notes_state"/{run.sh,supervise.sh,ensure-running.sh,status.sh,backup.sh,bin/node}
"$notes_node" "$notes_deploy/prepare-runtime.mjs" "$notes_state/app/notes-pipeline.mjs"
chmod 600 "$notes_package/writer.json" "$notes_state/writer.json"
printf '%s\n' 'Runtime and operations installed. Cron activation is a separate step.'
