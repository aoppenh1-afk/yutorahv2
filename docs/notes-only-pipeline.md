# Staged notes pipeline

The only processing pipeline is the Node/SQLite notes coordinator. It consumes complete official YUTorah VTT and publishes compressed TiDB notes, with hash-guarded replacements during explicitly authorized regeneration. The former audio-transcription worker, Antigravity runtime, operator UI, outline generator, and bundle-rewriting compatibility patches have been removed. Existing published transcripts, archive readers, schema history, and published notes remain available.

Generation uses the user-supplied `packages/notes-only/skills/written-shiur-notes/SKILL.md` unchanged. Its output is a compact written shiur in connected English prose with Hebrew terminology. The complete source is supplied on every generation and bounded repair; output is never shortened by truncating the source. The full contract and runtime configuration contribute to the profile hash. Changing the contract does not regenerate previously published shiurim.

## Output language guard

The `english-prose-1` validator rejects entirely or overwhelmingly Hebrew explanations for English or mixed transcripts. It checks the body separately from Markdown headings and ignores URLs. Hebrew-only notes may pass only when the complete transcript supplies Hebrew-language evidence. Ordinary English explanations can retain Hebrew titles, terms, and quotations. The guard runs during generation and its single repair, before artifact acceptance, before publication, and during crash-artifact recovery. A previous route or manual approval cannot bypass publication validation.

For reproducibility, the heuristic flags Hebrew bodies with no Latin letters, or at least 40 Hebrew letters and under 10% Latin letters. The source exception requires Hebrew letters and no Latin, or at least 40 Hebrew letters and at most 5% Latin letters (allowing occasional names). These are language checks, not assessments of source fidelity. Missing, changed, or unverifiable source evidence never grants the exception. The language policy is recorded with generator and validation evidence; the existing source contract and production qualification remain intact.

While paused and holding the runner lock, `language-audit [--apply] [--inventory FILE] [--report FILE]` inventories all public notes plus saved pending drafts. It checks verified local artifacts first, falls back to TiDB for missing notes, and verifies each Hebrew candidate against its exact transcript hash. Missing sources can be retrieved from the official VTT endpoint without inference. The read-only scan writes a private report; `--apply` first checks current public candidate hashes, snapshots SQLite and the report, and records durable findings. A complete scan is required before applying. An optional inventory file contains `{ "rows": [...] }` from the metadata-only keyset scan.

Affected jobs receive priority 3, above teacher priority 2 and normal backlog claims, with the old public hash retained for conditional replacement. Repeated application preserves work already queued. Unpublished bad drafts are preserved in immutable artifacts too. Normal preparation may be deferred with cached sources retained to make room for these repairs. Public notes stay visible until a valid replacement is verified, and successful publication resolves the recorded finding. The audit never starts model inference or resumes the paused supervisor.

When another publication wins a language repair's conditional replacement, the coordinator can adopt it only if it matches the exact current profile and pinned source, was created after the outstanding repair request and regeneration boundary, and passes every output-contract check. It preserves the locally generated alternative and records the canonical published hash. Other conflicts remain explicit.

`recheck-saved` runs only while paused with reconciled sessions and no live leases. It snapshots SQLite and the original checkpoints, then revisits urgent publication conflicts and rejected drafts. A formatting-only rejection can return to the publication queue when its last request completed with verified zero-cost runtime evidence, the saved raw/normalized output agrees, its original source/profile identity still matches, and the current normalizer makes it pass every check. Missing or changed evidence and substantive failures remain for review. Recovery records original request/attempt hashes and the new normalizer without making another model request or changing inference counters. A durable per-note report lives beside the snapshot under `STATE/audits/saved-recheck-TIMESTAMP/`.

## Install and operate

Use Node 22.13+ (the actual VM uses its private Node 24.20.0), Git, flock, and pinned OpenCode 1.18.33. The shell's Node 20 remains untouched.

```sh
PATH=/home/box/.local/share/yutorah-notes/bin:$PATH npm run notes:package
bash deploy/notes-only/install-vm.sh outputs/notes-pipeline /home/box/.local/share/yutorah-notes/bin/node
cd /home/box/.local/share/yutorah-notes
./run.sh runtime-check --opencode /home/box/.local/bin/opencode-notes
./run.sh enqueue --ids 1190357,1190833
./run.sh run --limit 2 --concurrency 2 --opencode /home/box/.local/bin/opencode-notes
./status.sh
./pause.sh
./resume.sh
./run.sh backup
./run.sh backup --audit
./rollback.sh
```

Run `./pause.sh` and wait for the supervisor and mutation locks before installing. Installation holds both locks, makes a consistent SQLite backup including WAL, verifies completed attempts/hashes and the credential fingerprint, installs an immutable release, imports legacy notes with original provenance, and atomically selects the new release. Reinstallation is supported. The public package contains no writer credential; installation reuses the existing mode-600 SELECT/INSERT credential. Database services, spending caps, and website deployments remain unchanged. Published note replacement is available only through the separately authorized regeneration workflow below.

`./resume.sh` removes the pause file and starts the supervisor. `./pause.sh` prevents watchdog restarts and cancels owned work; accepted artifacts remain durable. Automatic startup requires the VM's supported startup hook. The supplied cron installer preserves unrelated entries. A replaced host still needs its home directory and cron daemon restored; this is a separate recovery boundary.

In a source checkout, use `npm run notes:only -- COMMAND --state DIR`. The wrapper acquires the same mutation lock. Read-only `status` and `metrics` never migrate or reset active work. `migrate` performs explicit legacy reconciliation. `resume-route --upstream muse|yutorah|tidb` clears a route pause after its cause has been resolved.

## Coordinator and limits

The lifecycle is `discovered → fetching → ready → generating → generated → publishing → completed`. Missing sources get a seven-day recheck. Transient fetch failures stay retryable. Invalid input is blocked. Structurally invalid content gets at most one repair, then needs review. Source-fidelity review is independent of structural validity; explicit user waivers are recorded separately from completed reviews. Conflicting published hashes remain explicit conflicts with both immutable artifacts retained.

One coordinator owns the SQLite queue and inventory cursor. Its independent pools default to three fetchers, four generation workers, and one continuous publisher. The installed supervisor reads these counts from private `STATE/pools.json`, which survives upgrades. Publishers immediately consume saved notes; they do not wait for a periodic bulk flush. Starts are spaced by two seconds. Admission preserves at least 3 GiB of available memory, includes a conservative 512 MiB reservation per starting generation, and leaves a configurable disk reserve. Initial ready-buffer low/target/max values are 20/50/100. Source and outbox byte caps are each 1 GiB; the outbox also has a 1,000-item cap. In-flight reservations count against the bounds. The VM's actual headroom is checked before running. Use `help` for the current flags.

AI generation has a hard ceiling of six across the CLI, coordinator, limiter, server session creation, persistent pool settings, and qualification runner. Fetchers and publishers use ordinary HTTP/database operations. The default remains four and the exact-profile qualification still bounds production concurrency. Rejected/conflicting notes have a separate quarantine budget (10,000 records / 1 GiB by default); their sources, artifacts, and private attempt evidence remain retained and counted separately. Disk admission applies to all retained work.

Inventory resumes the existing paced catalog cursor, deduplicates IDs, and wraps to catch new publications. Explicitly enqueued jobs have bounded priority; every fourth claim services the oldest backlog. Within each priority tier, cached full sources lead speculative source preparation. Normal claims for requested teachers then favor the official lecture date (submission date is the fallback), rather than queue insertion order. Older queues backfill the requested teachers' date metadata one paced page per inventory turn, round-robin, without resetting discovery cursors or completion state. The latest teacher pages remain checked every thirty minutes. A trending list or catalog count is not evidence of usable transcript count. Plain numeric checkpoint files may be imported with `enqueue --file`; undocumented bitmap formats are not trusted.

A failed TiDB lookup leaves publication eligibility unknown. Fetching may fill the source buffer, but generation cannot treat an outage as evidence of an absent row. Publication consumes the accepted artifact independently and uses insert/readback/hash checks. During an explicitly authorized regeneration it uses a hash-conditional UPDATE for rows that already exist, preserving the old row until the complete new artifact is ready. A lost insert acknowledgement reuses that artifact. No publication failure repeats inference.

Regeneration retries recheck TiDB before another inference request. A concurrent public note can satisfy regeneration only when its source and approved profile match exactly, its creation time is within the regeneration epoch, and it passes the complete structural and source-aware language checks. Language repairs also require a publication newer than the queued finding. Matching concurrent publications complete the job while retaining any alternative local draft. While paused, `recheck-saved` applies the same checks to saved regeneration conflicts without inference or public writes.

YUTorah, Muse, and TiDB have independent persisted cooldowns. Numeric and HTTP-date Retry-After values are honored. Authentication, unconfirmed configuration, uncertain session ownership, or a paid selection pauses the affected route. Backoff is bounded with jitter. Filling the outbox stops generation; filling the source buffer stops fetching. Other stages can drain. A transient catalog failure backs off discovery for thirty seconds without cooling down transcript fetching; explicit upstream throttling and authentication failures still apply to both endpoints.

## Runtime safety and qualification

The fallback reference route is `--route acp-high`. Server generation is `--route server-high`; the installed `STATE/route` explicitly selects the active route. Both pin `opencode/muse-spark-1.3-contributor-free`, plan mode, High effort, and the same free small model. A locally authenticated server on 127.0.0.1 verifies the pinned live schema, effective configuration, and input/output/cache-read/cache-write zero prices. Catalog evidence expires after 60 seconds by default (maximum five minutes). No direct model API or paid fallback is used. One shared inference limiter accounts for both routes, repairs, retries, exposed helper requests, and conservative token reservations. The local request/token controls are operating limits, not claims about an undocumented provider quota.

Each request gets fresh context. Server sessions have explicit worker/job/attempt titles and a durable ownership ledger. ACP attempts own separate Git workspaces and process groups. Tools and permission requests are rejected. Cancellation aborts and confirms session termination before freeing the inference slot. Cleanup uncertainty pauses the route and retains recovery metadata. Only owned sessions are deleted. Server restart reconciles ownership before admitting replacement work. Each server request also has a three-minute silence deadline, refreshed only by growing assistant text or reasoning. Shared SSE heartbeats and unchanged history do not extend it. Silent requests are aborted, confirmed idle, and deleted before their worker slot is released; the pinned source remains ready for a backed-off retry. Notes that keep producing output retain the full request deadline.

Silence and reconciliation intervals use a monotonic clock, so system-clock adjustments cannot cancel healthy sessions or indefinitely extend silent ones. A delayed watchdog tick grants five seconds for queued output to resume. Before declaring silence, the monitor rechecks saved session history with a separate five-second deadline. New saved output resumes the request; an already completed history can recover a lost HTTP response without another model call, after the same independent identity, High-effort, zero-cost, completion and tool checks. Unchanged incomplete history still times out, and owned-session cleanup remains mandatory.

The pinned live schema gates one authenticated global event subscription shared by owned server sessions. It routes permissions/tools by session ID, reconciles full histories every 30 seconds while connected, and polls every two seconds when disconnected or unsupported. Reconnection immediately schedules reconciliation; final messages still provide complete identity/price/tool/usage evidence. First-output timing counts identified assistant messages, never echoed user prompts. Concurrent catalog refreshes share one verification promise. Completed requests release unused token reservations using the pinned runtime's additive input/output/reasoning/cache fields. Active and uncertain requests retain their reservations regardless of age; completed or interrupted usage remains charged for at least a minute after completion. Pre-dispatch estimates remain conservative.

Local JSON requests use bounded Node HTTP transport with the configured abort deadline covering both headers and body. A separate Fetch/Undici five-minute header timeout must not truncate the twenty-minute inference window. Only the owned authenticated loopback address is allowed; redirects are not followed. Sanitized transport error codes are recorded without response/source bodies or credentials.

OpenCode's bundled Bun runtime can leave extracted native `.so` libraries behind after exit. Both `TMPDIR` and `BUN_TMPDIR` point to a mode-700 `tmp` directory inside the owned server or ACP workspace. The server removes that directory after stopping, failed startup, and recovery of a previous process group. ACP cleanup removes it even when a session ledger must remain for recovery; recovery recreates scratch for its own cleanup commands. A running server retains its loaded library until shutdown, and repeated sessions share that one extraction. This prevents the per-launch library files from accumulating in shared `/tmp`.

For local-only trials, pause production; the runner acquires its mutation lock itself:

```sh
PATH=/home/box/.local/share/yutorah-notes/bin:$PATH \
  node --import tsx scripts/qualify-notes.ts --route server-high --concurrency 2 \
  --ids 1117682,1056185 --output PRIVATE_DIRECTORY
```

The qualification runner never constructs a TiDB writer. The default qualification policy requires at least 100 varied matched human-reviewed sources, followed by verified publication cohorts of 100, 500, and 1,000 notes and a 24-hour operational observation. Submit exact-profile evidence with `qualification --file FILE`. Concurrency above the qualified setting is rejected.

Trials above four require `--headroom-qualified`; none can exceed six. The runner refuses unpaused production, holds the production process lock throughout, uses the same 3 GiB / 512 MiB admission reserve, and records peak sessions and minimum available memory. Cached official VTT is hash-verified and reused when present, so matched trials can use identical complete sources. Each trial needs a separate output directory.

On October 14, 2026, the user explicitly waived human reviews and the 24-hour observation. Approval evidence records `waivers.humanReview`, `waivers.observation24h`, `requestedBy: "user"`, the instruction, and its timestamp. Human acceptance remains zero and no elapsed observation is invented. Without that explicit waiver evidence, the original requirements remain enforced. Waivers do not disable model identity, High effort, zero-price verification, bounded repairs, resource admission, or hash-verified publication.

`rollout --route server-high --all --follow --inventory` resumes a durable 100-note cohort, then separate 500- and 1,000-note cohorts. Failed or unavailable jobs do not count toward the published target. Each cohort has a persistent start boundary; it is limited to its remaining number of completions and independently reads back every row before advancing. Cohorts must contain distinct notes. Restarts recover prior completions instead of resetting the cohort. When all cohorts pass and the 24-hour requirement is explicitly waived, the supervisor records production approval and continues normal server generation. If an observation is still required, automatic production promotion stops. The supervisor uses this rollout command whenever `STATE/route` selects `server-high`.

## Durability, recovery, and rollback

Claims use `UPDATE … RETURNING`, unique ownership tokens, renewable leases, and conditional completion. Merely opening SQLite does not recover jobs. Expired leases are fenced before cancellation/reconciliation. A stale worker can leave an orphan but cannot accept it, replace an accepted hash, or publish it.

The running coordinator holds the kernel process lock. After an event-loop stall it may refresh an expired active lease only when the original token still matches and the job is still in an active stage. It records `lease:renewed_after_stall` and keeps the existing request. Ordinary renewal and completion remain strict; a fenced token or completed job cannot be revived. Work from a crashed coordinator still goes through the normal fenced runtime reconciliation.

Sources are pinned under `sources/ID/SHA.vtt`. Accepted notes live at `artifacts/ID/SOURCE_SHA/PROFILE/ATTEMPT`, with a gzip and a complete manifest. Files are synced and the manifest directory is atomically committed before acceptance. The durable attempt index allows recovery to adopt a matching completed artifact across the filesystem/SQLite crash gap. Corrupt or mismatched artifacts stop recovery rather than requesting another generation silently. Private prompts, raw responses, normalized artifacts, and metadata remain in `attempts/`; general logs contain only bounded classifications and metrics.

Backups consume the durable accepted-artifact journal. A repair query derives missing entries from accepted queue state. Normal backups read pending artifacts only; the coordinator performs a full integrity audit daily, and `--audit` requests one immediately. Gzip size and hashes are checked before copying and after atomic commit. Existing legacy backups and generated alternatives are preserved. Credentials, runtime sessions, transcripts, and prompts are excluded from these shared note backups. Sources are reclaimable only after verified completion, successful backup, and the retention interval. Orphans remain retained for investigation; no automatic orphan deletion is enabled.

`rollback.sh` pauses the worker and restores the ACP High route while retaining the v2 schema and all newer committed artifacts. This is the supported runtime rollback. Pre-v2 executables do not understand the staged queue and must not open it. Old code and the consistent pre-upgrade SQLite snapshot remain private recovery assets; restoring that snapshot over newer work would forget publications and is not a supported rollback.

`metrics` reports stage depths/bytes, sessions, p50/p95 stage latency, repair and retry classes, cooldowns, verified publications/hour, and an explicit observation window. Running logs include available memory and disk headroom. A short local pilot is not a sustained-throughput baseline or an ETA for the catalog.

Coordinator log records also include `eventLoopMaxMs` and `runtimeClock` (wall-clock gap, monotonic elapsed gap and their difference). A wall-only jump can therefore be distinguished from an execution gap; these measurements do not by themselves identify the hosting platform's cause. Runtime counters report final silence checks, recovered progress, completed histories and resume grace periods. Per-request observations retain the send clocks, monotonic response durations, recovered-history events and watchdog timeouts without recording note content.

Request observations separate admission waits (including reasons), runtime checks, session creation, first output, response completion, and confirmed cleanup. Generation and repair requests remain distinct. Ready wait, artifact commit time, first-pass validation, repair codes, token categories, completed source-hours, eligible ready depth, publishable backlog, and rolling five-/sixty-minute publication rates are reported alongside whole-stage metrics. Running logs also include event-loop p95 delay, current admission waits, and shared-monitor connection/read counts. `presentation-3` retains the newline, whitespace, fence, and heading-spacing normalization from `presentation-2`. When a complete source is supplied, it additionally removes Hebrew vowel/cantillation marks outside short quoted passages to enforce the existing unvocalized-prose contract. It preserves quotation text, consonants, word order, and source text. Unsupported vocalized quotations remain rejected. Raw/normalized output and versioned validation metadata stay private. This revision does not reset regeneration, change the prose/model/High profile, or manufacture new qualification evidence. See [the implementation research](notes-throughput-implementation.md).

`--follow` applies during bounded quality rollouts as well as production. A cohort waits for transient memory, disk, or upstream admission limits within its existing runtime deadline, and still stops at its selected-job/publication bound. It no longer exits into an empty supervisor restart cycle merely because an admission check temporarily prevents dispatch.

Resumed cohort progress also derives prior member IDs from the verified earlier cohort manifests. Repaired earlier members remain completed but cannot count again toward a later cohort. This upgrades retained progress without resetting its start time, modifying previous verification evidence, or weakening the final distinct-note check.

See [the actual VM report](notes-only-vm.md) for installation evidence and pending gates.

## Regenerating all notes with teacher priority

The user requested fresh generation of every old note, keeping the old public note visible until its replacement is ready. The requested first teachers are recorded in `deploy/notes-only/priority-teachers.json`. On the installed worker:

```sh
./pause.sh
./run.sh regenerate --file /path/to/priority-teachers.json --instruction 'Regenerate all notes; prioritize these ten teachers; keep old notes visible until replaced.'
./run.sh replacement-check
./run.sh catalog --pages 10
./resume.sh
```

Run regeneration once: repeating it refuses to erase new progress. The command requires the worker to be paused with all leases and sessions reconciled. It saves a consistent SQLite archive and original completion hashes under `STATE/upgrades/regeneration-TIMESTAMP`, preserves all immutable notes and backups, clears old completion checkpoints from the active queue, and records the user's instruction. Legacy note import is disabled for this generation epoch, including on reinstall. Status and metrics count the new epoch separately.

Teacher-filtered catalog pages use official numeric IDs and persist separate cursors. Discovery cycles through all ten teachers before the general catalog; their jobs have priority over ordinary backlog even on fairness claims. Existing queue IDs are deduplicated and promoted when encountered. Catalog counts do not establish transcript availability.

Every old public note is hash-verified and archived before replacement. Its hash is pinned in `jobs.replace_hash`. Publication uses `UPDATE ... WHERE shiur_id=? AND notes_sha256=?`, then independently reads/decompresses/checks the saved note. Lost acknowledgements reuse the accepted artifact; a concurrent conflicting write remains a conflict. No DELETE or destructive table reset is used. The installed TiDB v8.5.3 cluster requires table-scoped UPDATE permission in addition to SELECT/INSERT; column privileges require TiDB v8.5.6 or later. The replacement SQL itself updates only the seven content columns and never changes the shiur primary key. No DELETE or schema privileges are granted. `replacement-check` probes these rights using the impossible ID zero without changing any row. The website's existing caches can retain an older response until their normal expiry.
