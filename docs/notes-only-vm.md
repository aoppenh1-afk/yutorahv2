# Notes coordinator VM report

## Throughput hardening — October 15, 2026 (current installation)

Installed bundle: `1cf77bd71435a0c2f84a6b8f657bcc9da309e9908cd090895f93c9b33a86e877`. Production remains **server High with 3 fetchers / 4 AI generation sessions / 1 publisher**. The user requested a hard maximum of six AI sessions; every configuration and session-creation admission surface now enforces it. The 3 GiB memory floor and active reservations remain. The existing content profile, full-source contract, regeneration epoch, teacher priorities, published rows, and recorded review/observation waivers were preserved.

The update adds shared authenticated event monitoring with bounded reconciliation/fallback, coalesced runtime verification, corrected durable token accounting, deterministic `presentation-2` formatting, separate quarantine budgets including retained evidence, live-state indexes, and request/repair/resource telemetry. It also fixes an independently reproduced premature HTTP header timeout by giving local JSON requests one explicit cancellation deadline. Research, adoption/defer decisions, and measured limits are recorded in [the throughput implementation report](notes-throughput-implementation.md).

An isolated twelve-source four-session trial exposed host memory falling to 1,612.6 MiB and four six-minute transport failures. Six sources passed and two were gracefully cancelled during diagnosis; no trial notes were published. A delayed-server reproduction identified a shorter transport header timeout independent of the configured inference deadline. After the transport fix, both repeated canary sources passed first response, in 81.726 and 102.416 seconds, with a minimum sampled 5,770 MiB available memory. This is not a sustained throughput or fidelity measurement. Six-session production was not qualified or selected.

Verification: **70 pipeline/runtime/publication tests passed**, **11 deployment/transcript tests passed**, with one opt-in live catalog test skipped. Lint, TypeScript, package generation and installation/reinstallation/runtime rollback checks passed. The first installed build produced seven new publications and six passed additional independent TiDB readback. The final recovery fix was then installed, preserving all **1,198 completed checkpoints and hashes**, unchanged credentials, and SQLite integrity. The live pinned-runtime/zero-price check passed. Production resumed at four sessions. Final rollback assets are `STATE/upgrades/install-20261015T053902-663502`; private baseline, trial, timeout reproduction, and installed-index evidence are under `outputs/notes-throughput`.

## Server rollout and full regeneration — October 14, 2026

The current installed bundle is `2e7ff54a7f339827bcb5a3b0ff65a017e96737dd3dadb1abadd5ce25db9b2e56`. The selected and observed running route is **Muse Spark Contributor Free, High effort, through one persistent authenticated OpenCode 1.18.33 server**, with **3 transcript fetchers / 4 generation sessions / 1 continuous publisher**. Four actual simultaneous server sessions were observed, with no ACP generation process. The running server, schema, model, small model, High variant, and current zero prices passed verification. About 7.5 GiB available memory remained during the first concurrent run.

The user explicitly waived independent human review and the 24-hour observation. The exact instruction is retained in `STATE/authorizations` and `STATE/upgrades/server-rollout-authorization.json`; it records zero human reviews and no invented observation. A measured four-session trial under this exact prose profile supplies runtime/memory evidence. Automatic 100-, 500-, and 1,000-note publication cohorts remain in force. The supervisor independently reads back each whole cohort, persists its boundary across restart, and then continues normal server production without another approval request.

The user subsequently requested fresh generation of all notes, with the ten specified teachers first and old public notes visible until replaced. All **8,654 previous completion records and hashes** were archived consistently under `STATE/upgrades/regeneration-1792008157116`; the active queue was reset to fresh discovered work without deleting public notes, immutable artifacts, or backups. Legacy artifact re-import is disabled for this generation epoch, including on reinstall. The queue initially contained 14,780 distinct discovered jobs, including 1,309 priority jobs covering all ten teachers. Their official catalogs reported 52,034 records in total; transcript availability is separate. Independent per-teacher cursors continue discovery before the general catalog, and teacher priority also applies to backlog claims. A live filtered catalog page returned one unrelated speaker; the importer now excludes such a result by its returned teacher ID while preserving the verified raw page cursor.

After the user signed in to TiDB Cloud, the worker received **UPDATE on `yutorah_notes.shiur_notes`**, retaining SELECT/INSERT. The installed TiDB version is v8.5.3, which requires table-scoped permission rather than the column privilege feature added in v8.5.6. No DELETE or schema privilege was granted. The credential bytes and zero spending cap were preserved. An independent zero-row UPDATE probe passed. Every replacement first archives the verified old note, saves a fresh immutable generated artifact, performs a conditional UPDATE against the old hash, and independently verifies the published replacement. The old public row remains until this update commits. Existing website caches may show the older response until normal expiry.

The first four live replacements were independently read back and decompressed from TiDB: **1190936, 1190925, 1190997, and 1190978**. Every new hash differs from its pinned old hash, the exact server/prose profile matches, and generation timestamps are after the new epoch. Their immutable local artifacts also match. The pipeline remains running; later counts can increase. Evidence is in `STATE/upgrades/server-live-replacements.json`, `replacement-permission-verification.json`, and `server-regeneration-verification.json`. These short windows are not a sustained throughput estimate.

Verification for this update: **52 notes/runtime/publication tests passed**, plus **10 deployment/transcript tests passed** (one separately opt-in live catalog test skipped; real teacher-filtered inventory was exercised on the installed VM). Added coverage includes fresh regeneration rather than adopting old notes, consistent archival and reinstall protection, priority teacher filtering and scheduling, hash-conditional replacement with lost acknowledgement and denied permission, persistent 3/4/1 settings, explicit waiver boundaries, and resumable cohort verification/promotion. TypeScript, lint, shell syntax, package generation, installed runtime checks, and whitespace checks passed. Existing SIGKILL/lease/runtime recovery tests remain passing. No website deployment was needed for replacing rows in its existing notes table.

The rest of this document records the earlier ACP reference installation and its original preservation/recovery checks. Its pending human-review and 24-hour requirements are superseded by the user's explicit instruction above.

## Installation and preservation

The implementation is installed on `grok-bot-vm-358227731`, Linux x86_64, from `/home/box/yutorahv2`. The source baseline is commit `0e0450651707e9b73d29497fa133e102f89c629e` plus the working-tree implementation. Unrelated existing edits in `app/ui.tsx`, `tests/player.test.mjs`, and the teacher-notification research document were preserved.

Persistent state is `/home/box/.local/share/yutorah-notes`. The login shell still uses Node 20.19.2; operational scripts use `STATE/bin/node` 24.20.0. OpenCode remains pinned at `/home/box/.local/bin/opencode-notes`, version 1.18.33. The installed bundle SHA-256 is `07e664fa394a7148c10d1dd4109f09600a83dcaf2a83e579e1c5ab6c1ad98982`. The installed release is selected by `STATE/app`; `STATE/installation.json` records its full bundle SHA-256, source baseline/diff identity, contract SHA-256, schema, and rollback directory. Installation is repeatable and no longer rewrites bundled JavaScript with compatibility patches.

The supplied written-shiur notes skill was copied unchanged. Its SHA-256 is `4f1d397646a0ce30fd789c3e7031a687a59751f9e481f1c3fa54994ba507fc5b`. The ACP profile is `0a2f85fdc18d793dc2736f42bc3a3d3e0077e01199074e88e2770a76d35471af`; the server candidate profile is `fc1a9785e4f8108501bdf6c0ea46a4cf9ab915dfd3d4bfcbc24248c0e3957200`.

On arrival the old worker was paused, with no active notes process. The queue contained 8,649 completed jobs, 582 missing sources, 3,069 queued jobs, and five interrupted jobs; the catalog cursor was page 424. There was no running baseline observation from which to establish sustained throughput.

Migration preserved all **8,649 original completion hashes and attempt counters**, all **17,988 original note files**, and the exact writer credential bytes. The credential remains mode 600. SQLite integrity is `ok`. Legacy notes were verified and imported as immutable artifacts with their original generator provenance. The five interrupted jobs were reconciled without changing completed records. No published row, database spending cap, website deployment, or unrelated application was replaced.

The initial consistent SQLite backup, old executable/scripts, credential fingerprint, completion inventory, and file hashes are under `STATE/upgrades/staged-20261014T184529Z`. Each installation also creates `STATE/upgrades/install-TIMESTAMP-PID`. `staged-preservation-verification.json` independently records the original-hash checks. Private rollback assets include credentials and must stay private. Shared note backups exclude them.

## Active configuration

The running reference is **Muse Spark Contributor Free through fresh ACP, plan mode, High effort**. Both main and small models are pinned to `opencode/muse-spark-1.3-contributor-free`. The authenticated loopback server checks the live pinned schema, effective configuration, and current zero input/output/cache prices; it also gates ACP admissions. The server route remains an unpublished candidate.

One coordinator owns the queue. It runs four paced source fetchers, up to two generation workers, two publishers, and coordinated catalog discovery. VTT starts are spaced by 250 ms, inference starts by two seconds. Admission retains 3 GiB available memory plus conservative active reservations. Ready sources use low/target/max counts of 20/50/100. Source and outbox byte caps are each 1 GiB; the outbox count cap is 1,000 and disk reserve is 2 GiB. The VM had over 80 GiB available disk during installation. Unknown publication eligibility blocks inference. Missing sources receive scheduled rechecks.

Catalog discovery resumed the preserved cursor and separately checks the latest page every thirty minutes. Ready sources refill while inference and publication run. Durable generation claims from a previous process consume capacity until expired-lease reconciliation. Cooldowns and route pauses are persisted separately for YUTorah, Muse, and TiDB.

Cron was absent in this runtime and has been installed and started. The notes entries preserve unrelated crontab entries, check the supervisor each minute, register `@reboot`, and request an hourly incremental backup. The coordinator also drains the backup journal during normal operation and performs a full integrity audit daily. Full host/runtime replacement remains **unverified**: the platform must restore the persistent home and start cron. This managed environment does not expose a supported arbitrary cold-start service hook through its existing daemon supervisor.

## Verification results

- 46 queue/generator/runtime/TiDB tests passed. These include atomic claims, still-running stale owners, lease renewal, immutable orphan writes, actual SIGKILL before/after artifact and SQLite commits, lost acknowledgements, hash conflicts, cancellation, permission denial, restart reconciliation, shared repair budgets, memory/disk/outbox reservations, and exact bounded-pilot limits.
- Nine VM/package/transport tests passed. The separately opt-in catalog test was skipped because it takes the mutation lock; continuous installed inventory independently verified real catalog access and cursor advancement. The emitted installer passed idempotence, WAL-preserving backup, credential preservation, schema migration, and runtime rollback checks.
- All 48 published-content/archive/search tests passed with a disposable local PostgreSQL fixture. Both maintenance tests passed. The fixture database and role were removed and its cluster stopped afterward. Sources tests passed (40 tests; one external evaluation skipped).
- TypeScript, repository lint, shell syntax, whitespace checks, and the website build passed. No website deployment was performed.
- A real SIGKILL of the owned pinned server produced a new server PID and repeated schema/configuration/zero-price checks without inference. Evidence: `STATE/upgrades/staged-server-restart/verification.json`.
- Cleanup regression: OpenCode 1.18.33 returns successful abort for an already absent session, then DELETE 404. The adapter now independently confirms GET 404 before marking that owned session deleted. The regression test and live no-inference reproduction pass. No session is declared terminated merely because an HTTP client timed out.
- A controlled supervisor SIGTERM was recovered by the installed cron entry with a new PID. All 8,653 then-completed checkpoints retained their hashes and attempts. The complete check took 104.08 seconds including initial owner discovery and the next cron tick. Evidence: `STATE/upgrades/staged-watchdog-verification.json`.
- Runtime rollback was executed on the migrated schema: ACP High was selected while all newer committed work remained intact. A pre-v2 SQLite snapshot was not restored.
- Five new prose notes were independently verified through TiDB at the final readback checkpoint: **8,654 completed notes** total. `STATE/readback-verification.json` records hashes and the observation timestamp; the earlier independent checkpoint is retained as `STATE/upgrades/staged-final-readback.json`. Ongoing processing can advance this count.
- The first bounded three-job pilot selected exactly three IDs, published two notes, and retained one provider failure for retry. It took 90.64 seconds including recovery/startup, or 79.44 verified publications/hour when normalized from that short window. This is **not** a sustained baseline or corpus ETA. A subsequent retry exercised the bounded repair path and retained its source after another provider failure. Actual session accounting returned to zero after cleanup.
- The first full v2 backup audit verified 8,651 immutable completed artifacts; the final installation audit verified 8,654 with no pending journal entries. Later accepted artifacts are handled incrementally. The backup root is `~/.local/share/yutorah-notes-backup/v2`; the original legacy backup directory remains unchanged. Both are on the same VM disk and do not establish host-loss recovery.

## Candidate trials and remaining gates

With the supplied prose contract, one full ACP source passed structural checks in 48.04 seconds (54.53 seconds including startup/fetch/cleanup). Two concurrent server sources both passed, taking 38.31 seconds for their whole trial. Four concurrent server sources all passed, taking 64.24 seconds for that whole trial. The largest sampled owned server tree was 858,772 KiB (about 839 MiB). These windows ran separately and did not compete for timed provider quota. A preliminary four-source setup found one unavailable VTT and made no inference requests; a verified available source replaced it in a fresh trial.

All seven completed reference/candidate trial notes also passed the final structural validator, including unvocalized Hebrew prose. This does not establish source fidelity. Human-accepted candidate notes: **0**. Candidate notes published: **0**. Concurrency above four was not tested or promoted.

The 100-source matched human review, fully Hebrew and broad long-source coverage, verified 100/500/1,000-note candidate cohorts, and full 24-hour operational observation remain pending. The CLI records per-note human review and exact-profile qualification, requires independent cohort readback and staged cohort progression, and rejects continuous candidate production before the production gate. No candidate promotion or sustained-throughput claim is made.

Private trial manifests and frozen sources/prompts/raw outputs are under `STATE/upgrades/staged-evaluation-acp`, `staged-evaluation-server-2`, and `staged-evaluation-server-4b`. Other private evidence is under `STATE/upgrades`; normal runtime evidence is under `STATE/attempts`, `STATE/runs`, `STATE/runtime/server`, and `STATE/logs`. General logs omit credentials and note/source bodies.

## Actual operator commands

### Native-library temporary storage fix (2026-10-14)

The pinned OpenCode 1.18.33 server still extracts its 5,576,816-byte FFF native library to a new hidden `.so` file when native search loads. Two live no-inference reproductions each left one copy after graceful shutdown; repeated searches reused that extraction within the server. This is consistent with Bun's [embedded native-library extraction issue](https://github.com/oven-sh/bun/issues/30962). Bare `serve` startup and `--version` did not exercise the extraction, so a startup-only probe gave a false negative.

The installed fix confines `TMPDIR` and `BUN_TMPDIR` to owned mode-700 scratch. Server shutdown, failed initialization, and crash recovery remove this scratch after the process group stops. ACP attempts and cleanup commands use the same confinement. A retained session ledger does not retain its temporary libraries.

The installer preserved all 125 completed replacement checkpoints, credentials, the server route, and the 3/4/1 pool configuration. Targeted cleanup removed 28 unmapped, owner-matched copies with the independently verified FFF library hash: 156,150,848 bytes. Shared `/tmp` then had zero matching libraries, and the active production server mapped one library inside `STATE/runtime/server/tmp`. Four generation sessions resumed. Private live evidence is `STATE/upgrades/native-temp-verification.json`; local reproduction and cleanup evidence are in `outputs/opencode-temp-diagnosis`.

All 56 pipeline tests and three package/deployment tests passed on the installed Node runtime, including library confinement, graceful shutdown, killed-server recovery, initialization rejection, and retained ACP session-ledger recovery. TypeScript, lint, and whitespace checks passed. The live no-inference reproduction ran twice after the fix with no orphaned libraries.

```sh
cd /home/box/.local/share/yutorah-notes
./status.sh
./run.sh metrics
./pause.sh
./resume.sh
./run.sh backup
./run.sh backup --audit
./run.sh readback --limit 20
./run.sh restore --limit 20
./rollback.sh
```

`pause.sh` disables cron restarts and forwards cancellation through the supervisor. `resume.sh` starts the reference supervisor and lets cron recover it. `rollback.sh` pauses and selects ACP High while preserving the v2 queue and newer artifacts; inspect and run `resume.sh` afterward. Use `run.sh help` for bounded pilots, review, qualification, cohort verification, retry, and route-resume commands. Startup and state machines are described in [notes-only-pipeline.md](notes-only-pipeline.md).
