# Muse Free notes rollout — October 8, 2026

The main pipeline now defaults to Gemini transcription plus a separate
`opencode/muse-spark-1.3-contributor-free` notes worker. The notes pool has two
sessions; generation and helper models are pinned to the free variant, with no
paid or Gemini fallback. Completed notes retain their original versions.

The eight-shiur benchmark and two-session concurrency check succeeded. The
production service user's live `notes-check` also returned
`notes_provider_ready` after installing the verified OpenCode 1.18.33 binary at
`/usr/local/bin/opencode-notes`.

Production activation is pending database access. The configured Neon database
does not accept PostgreSQL connections, and its HTTPS SQL endpoint returned
**HTTP 402: account or project quota exceeded**. The operator was already offline
before this rollout. Its production migration command consequently failed before
connecting. No successful production DDL or queue update occurred; the existing
database and subscription configuration have been preserved.

The updated build, GUI, contracts and migrations are installed under
`/opt/yutorah-operator`, with build files in
`.worker-build-notes-20261008`. The operator environment now selects Muse Free.
A `DEPLOYMENT_PENDING` marker prevents the container's recovery loop from
starting this build before its required migrations finish. The reader and its
tunnel were left running. The previous operator environment and application
files are preserved in the root-only backup at
`/var/backups/yutorah/muse-notes-20261008T180312Z`.

Once the existing database accepts connections again, complete the cutover with:

```sh
sudo bash -e <<'SH'
runuser -u yutorah-worker -- bash -ec 'set -a; source /etc/yutorah-operator.env; set +a; cd /opt/yutorah-operator; exec ./bin/node .worker-build/apps/worker/src/cli.js migrate'
runuser -u yutorah-worker -- bash -ec 'set -a; source /etc/yutorah-operator.env; set +a; cd /opt/yutorah-operator; exec ./bin/node .worker-build/apps/worker/src/cli.js notes-check'
rm /opt/yutorah-operator/DEPLOYMENT_PENDING
bash /opt/yutorah-operator/deploy/transcription/start-operator.sh
SH
yutorah-queue status
```

The migration command is idempotent and stops on failure; the marker is removed
only after migration and the live free-model check succeed. Startup restores the
saved queue intent and Google quota deadline. If the queue was deliberately
paused, it remains paused until started. Keep Zen auto-reload disabled; this
cutover does not configure billing or change the Neon plan.

Verification: 149 worker tests passed before rollout, the worker build passed,
all three transcription-control tests passed, and the runtime installer rejected
a deliberately mismatched archive checksum. The container startup helper was
checked with the pending marker: it kept the operator stopped and left the
existing content service running. The ARM64 archive checksum is pinned from the
official release; that architecture was not exercised on this x64 host.

See the [benchmark and quality review](../benchmarks/opencode-notes-20261008/README.md)
and [operator guide](transcription-operator.md) for behavior and measurements.
