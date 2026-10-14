#!/usr/bin/env bash
set -euo pipefail
umask 077
notes_package=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
notes_state=${YUTORAH_NOTES_STATE:-"$HOME/.local/share/yutorah-notes"}
notes_node=${NOTES_NODE:-$(command -v node)}
"$notes_node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))throw Error("Node 22.13+ required");require("node:sqlite")'
mkdir -p "$notes_state"; chmod 700 "$notes_state"
exec 8>"$notes_state/supervisor.lock"
flock -n -E 75 8 || { echo 'Stop the notes supervisor before upgrading.' >&2; exit 75; }
exec 9>"$notes_state/process.lock"
flock -n -E 75 9 || { echo 'Stop the notes worker before upgrading.' >&2; exit 75; }
# Check credentials before installing any code; public packages reuse the installed private writer.
if [[ -f "$notes_package/writer.json" && -f "$notes_state/writer.json" ]] && ! cmp -s "$notes_package/writer.json" "$notes_state/writer.json"; then
  echo 'Writer credentials differ; the installed credential was preserved.' >&2; exit 1
fi
mkdir -p "$notes_state/upgrades" "$notes_state/releases" "$notes_state/bin" "$notes_state/logs" "$notes_state/notes" "$notes_state/jobs"
notes_stamp=$(date -u +%Y%m%dT%H%M%S)-$$
notes_backup="$notes_state/upgrades/install-$notes_stamp"
mkdir -p "$notes_backup"
# SQLite's backup API includes WAL data. Never restore this snapshot over subsequent committed work.
"$notes_node" "$notes_package/installation.mjs" snapshot "$notes_state" "$notes_backup"
for notes_file in run.sh supervise.sh ensure-running.sh status.sh backup.sh pause.sh resume.sh rollback.sh pool-settings.mjs pools.json teachers.json regeneration.json route installation.json; do
  [[ ! -f "$notes_state/$notes_file" ]] || cp -p "$notes_state/$notes_file" "$notes_backup/"
done
notes_hash=$(sha256sum "$notes_package/notes-pipeline.mjs" | cut -d ' ' -f 1)
notes_release="$notes_state/releases/$notes_hash"
if [[ ! -d "$notes_release" ]]; then
  notes_stage="$notes_release.partial-$$"
  mkdir -p "$notes_stage"
  cp "$notes_package/notes-pipeline.mjs" "$notes_package/manifest.json" "$notes_stage/"
  cp -R "$notes_package/packages" "$notes_stage/"
  mv "$notes_stage" "$notes_release"
fi
if [[ -d "$notes_state/app" && ! -L "$notes_state/app" ]]; then mv "$notes_state/app" "$notes_backup/app"; fi
if [[ -L "$notes_state/app" ]]; then readlink "$notes_state/app" >"$notes_backup/previous-release"; fi
ln -s "$notes_release" "$notes_state/app.next-$$"
mv -Tf "$notes_state/app.next-$$" "$notes_state/app"
# Never copy an executable over itself while it is running.
if [[ "$notes_node" != "$notes_state/bin/node" ]]; then cp "$notes_node" "$notes_state/bin/node.next"; chmod 700 "$notes_state/bin/node.next"; mv "$notes_state/bin/node.next" "$notes_state/bin/node"; fi
for notes_file in run.sh supervise.sh ensure-running.sh status.sh backup.sh pause.sh resume.sh rollback.sh installation.mjs pool-settings.mjs; do cp "$notes_package/$notes_file" "$notes_state/$notes_file"; done
[[ -f "$notes_state/pools.json" ]] || printf '%s\n' '{"fetchers":3,"generators":4,"publishers":1}' >"$notes_state/pools.json"
chmod 600 "$notes_state/pools.json" "$notes_state/pool-settings.mjs"
chmod 700 "$notes_state"/*.sh "$notes_state/bin/node"
if [[ ! -f "$notes_state/writer.json" && -f "$notes_package/writer.json" ]]; then cp "$notes_package/writer.json" "$notes_state/writer.json"; fi
[[ ! -f "$notes_state/writer.json" ]] || chmod 600 "$notes_state/writer.json"
export NOTES_ASSET_ROOT="$notes_state/app" YUTORAH_NOTES_LOCK_HELD=1
"$notes_state/bin/node" "$notes_state/app/notes-pipeline.mjs" migrate --state "$notes_state"
"$notes_state/bin/node" "$notes_package/installation.mjs" verify "$notes_state" "$notes_backup"
rm -f "$notes_state/pool.mjs" "$notes_state/backup.mjs" "$notes_state/catalog-fetch.mjs"
printf 'Installed %s; rollback assets: %s\n' "$notes_hash" "$notes_backup"
