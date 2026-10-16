# Notes pipeline handoff audit — October 16, 2026 (UTC)

This compares the supplied October 14 `yutorahv2-pipeline-vm-handoff.md` with the installed pipeline and subsequent explicit user instructions. Counts below are a moving live snapshot, not a forecast.

## Transcript availability and selection

Model workers claim only durable, validated official VTT with known publication eligibility. Missing-source probes run in the independent fetch pool; confirmed missing jobs receive a seven-day recheck. The public catalog response inspected during this audit contains recording/submission dates but no transcript-availability flag, so unseen IDs still require an official VTT check.

In the sampled thirty minutes, six missing-source probes took about 0.7 seconds combined. Eighteen source preparations succeeded; twenty eligible cached sources were waiting. The twenty-six generated notes averaged about 122 seconds for the generation stage, and four failed generations timed out. Memory admission also repeatedly delayed new sessions. This window does not support missing probes as the principal throughput bottleneck.

The ten requested teacher IDs are installed and precede ordinary catalog backlog. The audit found a separate ordering defect: dates were discarded and equal-priority work used insertion order. Recently discovered lectures could wait behind much older recordings. The correction stores the official lecture date, falls back to submission date, and uses it for normal priority-teacher claims. Cached source preparation leads speculative fetches within the same priority tier. Fairness claims retain older backlog progress, and urgent repairs retain their higher priority. Existing teacher date metadata backfills incrementally without resetting the crawler or completions; undiscovered availability is never treated as confirmed.

## Handoff architecture in operation

- One Node/SQLite coordinator owns asynchronous discovery, source, generation and publication pools.
- One authenticated loopback OpenCode 1.18.33 server serves fresh owned Muse Contributor Free sessions with explicit High effort. Both model selections and zero prices are checked. ACP High remains the rollback route.
- Complete official transcript text and the complete current user-supplied written-shiur contract are supplied. Structural checks and bounded repair remain; throughput tuning does not shorten sources or silently change effort.
- Renewable claims, immutable artifacts, crash reconciliation, independent TiDB readback, shared inference limits, upstream cooldowns, bounded buffers and incremental backups are implemented and covered by failure/recovery tests.
- Active settings are three fetchers, four generation sessions and one publisher. The ready buffer is 20/50/100. Admission retains the 3 GiB memory threshold, plus active reservations, and disk/outbox bounds. These are conservative settings, not established optima.
- The handoff's conditional inference ceiling was ten; the implementation caps it at six, and the recorded production qualification is for four. Higher concurrency has not been shown sustainable on this VM. Publication averages under a second in the sampled window, so adding publishers is not supported as a useful optimization here.

## Later instructions and incomplete evidence

The original handoff required at least 100 matched human source reviews and a full twenty-four-hour observation before candidate promotion. Those were **explicitly waived by the user**, not completed. The production evidence still records zero human reviews. Independent hash/readback cohorts of 100, 500 and 1,000 notes are recorded as verified; these do not establish source fidelity or a sustained throughput rate.

The original handoff specified insert-only publication and preservation of old completions. The later explicit regenerate-all instruction authorized fresh notes and hash-conditional replacement while keeping old public rows visible until replacement. That instruction supersedes insert-only behavior for this regeneration epoch; it does not authorize destructive deletion.

The supplied written-shiur contract replaced older notes-contract references under later instructions. The full Lectern transcription reference is retained independently. The two contracts should not be described as identical.

Packaging compatibility rewrites were retired in favor of immutable bundled releases with recorded source/bundle identities. Installation preserves checkpoints and credentials under locks and makes consistent SQLite backups. Cron recovery is installed. Recovery from complete host/disk replacement remains unproven; the second local backup is on the same VM disk.

## Throughput work, in order

Correct teacher recency and verified-source selection first, then distinguish actual provider silence from host execution/clock anomalies using the installed monotonic diagnostics. Keep enough prepared work available, but do not interpret idle workers caused by memory admission as a source shortage. Measure actual server memory and active reservations before changing admission or trying additional sessions. Compare four and six only under a controlled, qualified test; do not assume a ten-worker setting produces ten-worker throughput. Medium effort or another model remains a separate quality experiment, not a production shortcut.

The handoff's benchmark and synthetic rates were explicitly limited. No ETA or restored hourly-rate claim should be inferred from a short burst, catalog size, or reconciled already-public notes.
