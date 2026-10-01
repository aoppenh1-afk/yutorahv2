#!/usr/bin/env bash
set -euo pipefail
# Install separately on an existing VM without restarting its worker.
[ "$EUID" -eq 0 ] || { echo 'Run this installer with sudo.' >&2; exit 1; }
control_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/transcription-control.mjs
install -m 0755 "$control_source" /usr/local/bin/yutorah-queue
echo 'Installed yutorah-queue. Run yutorah-queue help.'
