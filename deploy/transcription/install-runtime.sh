#!/usr/bin/env bash
set -euo pipefail
umask 022

# Pinned Google archives, downloaded and hashed on 2026-09-24. The ACP registry
# has no published checksum field; these pins are locally verified artifacts.
version=1.2.1
case "$(uname -m)" in
  x86_64)
    asset=agy-acp-server-1.2.1-linux-x86_64.zip
    checksum=9fbf0bd584a26478161f637cabd75113f72541c842d148f578ef1a6a9edcb843
    executable_bytes=919951920
    harness_bytes=132815192
    ;;
  aarch64|arm64)
    asset=agy-acp-server-1.2.1-linux-arm64.zip
    checksum=7e7ef4088bc185e1af4204029e0f4ec4210af20724f3ff262186ac0bcea6aa0e
    executable_bytes=921424555
    harness_bytes=125568904
    ;;
  *) echo 'Supported platforms: Linux x86-64 and ARM64' >&2; exit 1 ;;
esac
[ "$(uname -s)" = Linux ] || exit 1
destination=${1:-/opt/antigravity-acp/$version}
if [ -e "$destination" ]; then
  echo 'Destination exists. Stop the worker and install into a new directory for an explicit upgrade.' >&2
  exit 1
fi
parent=$(dirname -- "$destination")
mkdir -p -- "$parent"
staging=$(mktemp -d "$parent/.acp-install.XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT
curl --fail --location --proto '=https' --proto-redir '=https' --max-time 600 --max-filesize 400000000 \
  "https://dl.google.com/agy-extensions/releases/linux/$asset" -o "$staging/runtime.zip"
printf '%s  %s\n' "$checksum" "$staging/runtime.zip" | sha256sum --check --status
printf '%s\n' agy_acp_server.par localharness_external > "$staging/expected"
unzip -Z1 "$staging/runtime.zip" | sort > "$staging/members"
cmp "$staging/expected" "$staging/members"
mkdir "$staging/release"
# Extract fixed members to regular files; never trust archive paths or symlinks.
unzip -p "$staging/runtime.zip" agy_acp_server.par > "$staging/release/agy_acp_server.par"
unzip -p "$staging/runtime.zip" localharness_external > "$staging/release/localharness_external"
[ "$(stat -c '%s' "$staging/release/agy_acp_server.par")" = "$executable_bytes" ]
[ "$(stat -c '%s' "$staging/release/localharness_external")" = "$harness_bytes" ]
chmod 755 "$staging/release/agy_acp_server.par" "$staging/release/localharness_external"
printf '%s\n' "$checksum" > "$staging/release/archive.sha256"
mv -T -- "$staging/release" "$destination"
echo "Installed Google Antigravity ACP $version in $destination"
