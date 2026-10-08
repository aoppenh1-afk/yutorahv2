#!/usr/bin/env bash
set -euo pipefail
umask 077
# Install the native runtime used by the free notes worker, alongside normal OpenCode.
[ "$EUID" -eq 0 ] || { echo 'Run this installer with sudo.' >&2; exit 1; }
notes_target=${1:-/usr/local/bin/opencode-notes}
[[ "$notes_target" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Use an absolute binary path without spaces or shell characters.' >&2; exit 1; }
notes_version=1.18.33
case "$(uname -sm)" in
  'Linux x86_64') notes_arch=x64; notes_sha=e546123213ae47909a4268692aa4b94950d011afe9cac9938753a2194f1c16d5 ;;
  'Linux aarch64') notes_arch=arm64; notes_sha=c63486624621924bf43be5c01abd252885661a734814224f6d70188a33aea858 ;;
  *) echo 'The notes runtime requires Linux x64 or ARM64.' >&2; exit 1 ;;
esac
notes_temp=$(mktemp -d)
trap 'rm -rf "$notes_temp"' EXIT
notes_archive=${OPENCODE_ARCHIVE:-$notes_temp/opencode-linux-$notes_arch.tar.gz}
if [ -z "${OPENCODE_ARCHIVE:-}" ]; then
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 \
    "https://github.com/anomalyco/opencode/releases/download/v$notes_version/opencode-linux-$notes_arch.tar.gz" \
    --output "$notes_archive"
fi
printf '%s  %s\n' "$notes_sha" "$notes_archive" | sha256sum --check --status
tar -xzf "$notes_archive" --no-same-owner -C "$notes_temp" opencode
[ "$(OPENCODE_DISABLE_AUTOUPDATE=true "$notes_temp/opencode" --version)" = "$notes_version" ]
install -D -m 0755 "$notes_temp/opencode" "$notes_target"
printf 'Installed OpenCode %s notes runtime at %s\n' "$notes_version" "$notes_target"
