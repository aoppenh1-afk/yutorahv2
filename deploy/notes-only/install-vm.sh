#!/usr/bin/env bash
set -euo pipefail
notes_package=${1:?Provide the newly built notes-pipeline package}
notes_node=${2:-/home/box/.local/share/yutorah-notes/bin/node}
NOTES_NODE="$notes_node" bash "$notes_package/install.sh"
