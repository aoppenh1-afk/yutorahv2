# YUTorah notes pipeline: implementation and VM installation handoff

Prepared October 14, 2026. This document is for a fresh coding-agent chat running on the user's cloud VM, called Cursor. It contains the final decisions from the queue architecture review and the completed local inference pilot. The VM agent must verify the current installation before changing it.

## Start here

Implement and install the staged notes pipeline described below. Upgrade the existing worker when it is present. Preserve published notes, queue checkpoints, full Lectern contracts, private credentials, and unrelated applications. Perform the implementation, focused tests, packaging, reversible installation, and recovery checks. Use the current approved ACP High route while a persistent-server candidate is awaiting qualification. Promote that candidate only after its quality and operational gates pass.

The user wants an agent to do this work on the VM, not produce another architecture proposal. Continue through executable implementation and installation within these constraints. Report any remaining human-review or host-access requirement precisely. A prepared but inactive candidate is different from a completed production rollout.

This is a $0 inference and infrastructure upgrade. The restriction applies to the pipeline's model requests and hosted resources. It does not establish the billing of the coding agent executing this handoff.

## Final architecture decisions

- One VM and one Node.js coordinator owning the SQLite queue.
- Separate asynchronous pools for inventory, official VTT preparation, generation, and TiDB publication. Validation follows generation locally.
- One persistent OpenCode server per VM for the candidate generation route. Multiple independent sessions use that server; every shiur gets fresh session context. The coordinator schedules ordinary code workers. An AI supervisor or subagent hierarchy is unnecessary for processing notes.
- One complete official transcript per generation request. Preserve all cue text and the full notes contract. Each repair is separately bounded and counted.
- A bounded ready-source buffer and a bounded durable note outbox. Backpressure propagates from publication to generation to fetching.
- Atomic claims, renewable leases, immutable saved artifacts, and idempotent insert-only publication with independent readback.
- A shared inference limiter across ACP, server sessions, generation, and repairs using the same provider. Different runtimes or models do not establish independent quota buckets.
- Continue using TypeScript/Node.js, SQLite, existing transcript code, and TiDB. The evidence does not justify adding Redis, Ray, Temporal, Kubernetes, a GPU server, or a new paid service.

Processing order:

```text
inventory -> discovered jobs -> complete VTT preparation -> ready sources
          -> admitted generation -> structural checks -> durable artifact
          -> independent TiDB publication -> verified completion
```

Muse High through the persistent server is the leading candidate. Muse High through fresh ACP is the existing production reference and rollback route. Muse Medium remains an evaluation candidate. No changed route has passed the source-fidelity promotion gate yet.

## Evidence already collected

The October 14 pilot used OpenCode 1.18.33 and `opencode/muse-spark-1.3-contributor-free`. Eight complete sources represented five speakers and short Halacha, Mishna, longer Gemara, Machshava, and Nach. All catalog languages were English, with mixed Hebrew terminology. Fully Hebrew lectures were not tested.

| Route | Attempts | Structurally valid | Median successful note |
| --- | ---: | ---: | ---: |
| Muse High, fresh ACP | 3 | 1 | 103.34 seconds |
| Muse Medium, fresh ACP | 8 | 8 | 74.89 seconds |
| Muse High, persistent server | 8 | 8 | 77.11 seconds |
| MiMo V2.6 Flash, fresh ACP | 5 | 4 | 148.29 seconds |
| Nemotron 3.5 Lightning, fresh ACP | 2 | 0 | No completed note |

Server High and ACP Medium took 565.7 and 566.7 seconds respectively across their timed notes. Server High produced 19% more words. Word count does not establish source fidelity. Including server startup and cleanup, its batch took 575.5 seconds.

All server trials were sequential on an ARM Mac with 8 GiB RAM. The owned server process tree peaked at about 564 MiB in that sequential run. Concurrent VM memory, throughput, rate limits, session isolation, and recovery were not measured. ACP failures were censored by three-minute prompt deadlines; they do not establish that ACP High can never complete. Load, trial order, and caching were not controlled.

The same eight available transcripts were fetched in three rotated rounds. Four concurrent VTT fetches had a median batch time of 0.79 seconds, versus 12.50 seconds for sequential VTT and 1.22 seconds for an eight-ID JSON batch. JSON used 12.73 times the decoded body bytes. These small retrieval trials do not establish sustained upstream capacity or catalog transcript availability.

A harmless direct request to the documented free Responses endpoint returned HTTP 403 `FreeTierError`, stating that the free tier required OpenCode. Use the supported OpenCode runtime; the benchmark supplies no approved direct-API alternative.

Completed inference metadata reported $0, and selected catalog prices were zero. This was not an independent billing audit. Human-accepted benchmark notes: 0. Benchmark notes published to TiDB: 0. The 100-pair review, 1,000-note VM pilot, and 24-hour observation remain outstanding.

Source review found defects despite passing structural validation. ACP Medium changed Mishnayos fifteen and sixteen to sixteen and seventeen in one note. Both Medium and server High dropped a tentative qualifier in a Turkish-coffee discussion. Server High copied nikud into ordinary Hebrew prose contrary to the contract. MiMo repeatedly altered Hebrew script and attributions. Structural success is insufficient for unattended acceptance of a candidate route.

The catalog's approximately 434,886 records are not a count of usable transcripts. The owner-reported roughly 300 notes/hour is not an instrumented baseline. Synthetic scheduler estimates of 436 or 594 notes/hour exclude real inference, quota, network, memory, and publication limits. Calculate an ETA only from measured eligible work and sustained verified throughput.

## Phase 0: inspect the actual VM and preserve a rollback

1. Confirm that the agent is executing on the intended VM. Find the repository, installed worker, persistent storage, Node binary, OpenCode binary, active processes, startup hooks, and credentials by location and permissions. Read applicable local instructions.
2. Inspect Git status and the deployed version. Preserve existing edits. Compare source, packaged bundle, deployment patches, and active configuration. Record versions and file hashes without printing secrets.
3. Capture a baseline of completed jobs, hashes, attempts, queue states, active inference, publication rate, stage latency, memory, disk use, and throttles. Use a bounded observation window with enough completions to describe its limitations.
4. Before migration or installation, prevent the watchdog from racing the upgrade, stop new admissions, and drain or cancel owned jobs cleanly. Save the old runtime, configuration, startup scripts, and a consistent SQLite backup. Use SQLite's backup mechanism or a controlled consistent snapshot; copying a live database file alone can omit WAL data.

Repository documentation describes this prior installation. Treat these as discovery hints, not guaranteed current facts:

| Item | Previously documented location or behavior |
| --- | --- |
| State | `/home/box/.local/share/yutorah-notes` |
| Installed bundle | `STATE/app/notes-pipeline.mjs` |
| Private extracted package | `/workspace/yutorah-notes-vm/notes-pipeline` |
| Node | `STATE/bin/node`, copied from Node 24.20.0 |
| OpenCode | `/home/box/.local/bin/opencode-notes`, version 1.18.33 |
| Credentials | `STATE/writer.json`, mode 600, SELECT/INSERT only |
| Saved notes | `STATE/notes/<shiur_id>/notes.md.gz` and `metadata.json` |
| Temporary work | `STATE/jobs/<shiur_id>` |
| Additional local backup | `/home/box/.local/share/yutorah-notes-backup/notes` |
| Watchdog | Cron, `ensure-running.sh`, a `paused` file, and kernel locks |
| Host runtime | Managed VM; systemd previously unavailable |

The package requires Node 22.13 or later with `node:sqlite`. The login shell previously resolved Node 20, so operational scripts used the private Node binary explicitly. Preserve that separation. The second backup directory is on the same VM disk and does not prove recovery after loss of the host disk.

If only a private bundle is installed, locate or obtain the matching source before making a large queue migration. Reuse the installed writer credential. A public source checkout does not contain that credential.

Completion: actual paths and runtime versions are identified, the baseline is recorded, existing artifacts are inventoried, and rollback assets are verified.

## Phase 1: telemetry and an early persistent-server adapter

Implement a runtime adapter at the existing generation request interface. Keep the full generation contract, normalization, structural validator, and repair behavior behind that interface. Select ACP High or server High explicitly through a feature flag. Test the server before depending on an entire queue rewrite.

Server requirements:

1. Start one pinned `opencode serve` process bound to `127.0.0.1`, authenticated locally, with private isolated configuration and an owned working directory. Verify the expected version, health, and live OpenAPI schema. Observe the installed schema rather than copying an unverified current SDK shape.
2. Pin both the main model and `small_model` to `opencode/muse-spark-1.3-contributor-free`. Before admitting generation or repair, verify zero input, output, cache-read, and cache-write prices in the current runtime catalog under a defined freshness policy. Configure plan mode and High effort, then verify effective configuration and supported request fields. An unavailable or priced selection stops the route. Keep autoupdate disabled during qualification.
3. Create a fresh explicitly titled session for each independent generation request. Persist session ownership and its job/attempt association for recovery. A bounded repair may use its own fresh session. Context from different shiurim must never share a conversation.
4. Submit the complete prompt with the exact provider/model, plan agent, and High variant. The pilot's message body used `model: { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' }`, `agent: 'plan'`, `variant: 'high'`, and a text part. Confirm those fields against the pinned runtime's `/doc` and effective message metadata.
5. Retain runtime behavior needed for the permitted free route while denying execution of file, shell, editing, browsing, or other agent tool actions. Handle permission events and tool attempts without hanging; abort and classify an off-task request.
6. Count every generation, repair, retry, and visible helper request against the shared budget. Verify response identity and exposed prices/cost. Stop on a paid route, unconfirmed configuration, authentication failure, or exhausted free quota. Preserve work for a permitted retry.
7. On timeout or cancellation, abort the owned session and confirm termination. A client HTTP timeout alone does not prove the server stopped generating. Reconcile uncertain sessions before admitting replacement work.
8. Delete only sessions owned by this worker. Retain recovery metadata when cleanup fails. Restart a failed server with bounded backoff; reconcile active leases and saved artifacts before requesting another generation. Test one hung session separately from a server-wide failure.

Use workload-appropriate configurable deadlines. Record timeouts as failed or censored attempts. The pilot's three-minute limit is not a production timeout recommendation.

Run concurrent candidate trials at 2 and 4 sessions first. Try 6, 8, and 10 only when measured headroom and provider behavior support them. Record the whole server's memory, accepted completions, cleanup, and contention. Keep reference/candidate comparisons from silently competing for the same quota during timed windows.

Completion: a feature-flagged server adapter produces isolated full notes, confirms model/effort, handles cancellation and restart, and has measured concurrent behavior. This phase does not promote its outputs to production.

## Phase 2: staged SQLite queue and safe artifacts

Use a single coordinator with short SQLite transactions and network/model I/O outside transactions. Retain WAL, durable synchronization, and a busy timeout. The existing CLI and deployment locks serialize mutations. Integrate all stage workers under one owner before running discovery alongside processing.

Recommended lifecycle:

```text
discovered -> fetching -> ready -> generating -> generated -> publishing -> completed
fetching -> missing -> scheduled recheck
fetching -> discovered, with a retry time
generating -> ready, after cancellation/recovery and artifact reconciliation
publishing -> generated, retaining the same accepted artifact
invalid content -> bounded repair, then needs_review or blocked
```

`generated` means structurally valid and durably saved. Track source-fidelity review separately, including route/profile approval and any per-note rejection or review requirement. Current approved-route publication may retain its existing policy; experimental-route publication requires the quality gates below.

Persist at least the shiur ID, job/profile identity, pinned source hash/path, stage, priority, next eligible time, lease token/expiry, per-stage attempt counts, accepted artifact path/hash, generator identity, review disposition, and bounded error classification. Generator identity includes the complete contract, model, effort, and runtime configuration relevant to reproducibility.

Preserve completed legacy jobs during migration. Import existing published notes as immutable completed records with their original provenance. Creating a new generator version must not automatically regenerate or replace already published shiurim. Pin a source revision for each attempt; handle changed source content explicitly. TiDB remains keyed per shiur and insert-only, so a versioned local job does not grant permission to replace its published row.

Ownership and commit rules:

1. Atomically claim an eligible stage with `UPDATE ... RETURNING`, a new ownership token, and lease expiry. Renew through conditional updates using that token. Terminal updates require the same current owner.
2. An expired lease makes a job recoverable; it does not stop its previous process. Cancel/reconcile the old request and prevent that worker from accepting a late result.
3. Write results to immutable attempt-specific paths identifying shiur, source, generator, and attempt. Verify hashes, sync files, and commit a complete artifact manifest through atomic rename and directory sync.
4. Select the accepted artifact through a conditional SQLite update while ownership is valid. A late worker may leave an orphan artifact, but cannot overwrite an accepted file, replace its hash, or publish an unaccepted result.
5. Recover the file/SQLite crash gap. Adopt a verified matching artifact only under current coordinator ownership and a defined reconciliation rule. Reuse a complete accepted artifact after a crash instead of repeating inference.
6. Publication retries always reference the immutable accepted artifact. Freeze that identity before publishing. Lost acknowledgements trigger hash-verified readback. Identical rows complete the job; conflicting rows remain explicit conflicts.

Authentication, configuration, and paid-route failures pause the route globally. Missing sources, malformed input, and content-review failures have per-job handling. Recover only expired leases, not every active job whenever a CLI command opens SQLite.

Completion: legacy completion counts/hashes survive migration, stale workers cannot change accepted artifacts, and restart tests demonstrate artifact reuse and safe publication.

## Phase 3: continuous worker pools and backpressure

Initial settings are conservative experiment values, not measured optima:

| Control | Initial setting |
| --- | --- |
| Inventory | 1 coordinated crawler/importer |
| Official VTT fetches | 4 bounded requests, with conservative pacing |
| Candidate inference | 2 sessions, then measured trials at 4 and above |
| Inference ceiling | 10, subject to all admission checks |
| Inference start spacing | Preserve the existing two-second spacing initially |
| Available-memory admission threshold | Preserve the existing 3 GiB threshold initially |
| TiDB publishers | 2 bounded operations |
| Ready sources | Low 20, target 50, maximum 100 initially |
| Ready-source bytes | At most 1 GiB, further reduced for actual disk headroom |

Make these configurable. Adjust source-buffer depth to observed refill delays and source availability. The earlier proposal's 100/300/500 thresholds are optional tuning values, not required starting sizes. Define an outbox byte cap and a disk reserve from the actual VM before enabling continuous generation. Include active reservations so several workers cannot collectively exceed a cap.

Inventory imports verified existing catalog/checkpoint IDs with deduplication, preserves completions, and discovers new shiurim continuously. Verify bitmap/checkpoint data before using it; a trending leaderboard is not the full corpus. Keep the existing paced crawler and cursor instead of recrawling the library by default.

Fetchers stage complete official VTT durably, parse all cues with the existing validation rules, and record the original source hash. Confirmed unavailability gets a scheduled recheck; network errors and throttles stay retryable. Avoid repeated known-published work. If TiDB is unavailable, preparation may fill its bounded buffer, but a job with unknown publication eligibility must not treat the failed lookup as proof that no note exists.

Generation claims only eligible ready sources, under session, rate/token, memory, disk, and route-approval limits. Retain the full Lectern contract and current structural checks. Preserve proofs, objections, authority disagreements, chronology, qualifications, and source uncertainty. Keep original Hebrew quotations and the contract's language rules. Shorter output is not automatically an improvement.

Publication consumes saved artifacts independently of generation, preserving existing TiDB insert/readback/hash logic. The current pipeline already saves notes before publication and reuses that backup after failure. The split frees inference workers and separates retries; preserve this working behavior.

Cooldowns are per upstream: YUTorah fetching, Muse inference, and TiDB publication. Honor numeric and HTTP-date `Retry-After`, use bounded backoff with jitter, and record the reason/duration. Filling the outbox pauses generation, then filling the ready buffer pauses fetching. A route pause should leave unrelated stages able to drain within their bounds.

Use one limiter for the provider across all sessions and repair calls. Account for exposed input/output/reasoning tokens and conservative reservations. Actual unknown quota ceilings remain unknown; infer operating settings from observed responses rather than inventing a published allowance. Give user-requested jobs bounded priority while guaranteeing backlog progress.

Completion: ready work refills continuously, missing-source checks occupy no inference slot, TiDB retries occupy no inference slot, service cooldowns stay isolated, and enforced byte/count bounds survive outages.

## Phase 4: quality qualification and operational gates

Run in increasing scope. Preserve frozen sources, complete prompts, raw outputs, normalized artifacts, route metadata, repairs/failures, source/profile hashes, and test manifests privately. Runtime success, structural success, human acceptance, and verified publication are separate counts.

1. Focused queue/runtime tests must cover claim races, lease expiry with a still-running worker, stale file writes, crash before/after artifact commit, cancellation, server restart, lost TiDB acknowledgement, hash conflicts, missing VTT versus transient failure, cooldown isolation, memory admission, and disk/outbox saturation. Demonstrate bounded pilots cannot exceed their requested job limit.
2. Compare at least 100 varied matched sources using current ACP High and candidate server High with the same full contract. Include long and short shiurim, fully Hebrew lectures, English/Hebrew mixtures, multiple speakers, and several subject areas. Use independent human source review, preferably blind to the route. The source transcript is the reference; ACP High is also fallible.
3. Require accepted notes to retain substantive source coverage, arguments, objections, qualifications, correct attribution/quotations/citations, and speaker uncertainty. Critical invented or altered content is a failure. Record accepted counts and rejection reasons. Automatic rules or an AI judge cannot substitute for this human gate.
4. After quality approval, run controlled VM cohorts of 100, then 500, then 1,000 notes. Include independent TiDB readback and checkpoint/artifact verification. Candidate notes stay local until their applicable publication gate passes. Use real failure injection in an isolated test state before testing controlled live interruptions.
5. Observe the chosen configuration for a full 24-hour window, including quota pauses and watchdog recovery. Compare verified throughput and failure/repair rates with the measured reference baseline. A smaller successful pilot is not a completed 24-hour test.

Publish metrics for stage states/depth/bytes, actual generating sessions, p50/p95 stage latency, repairs, retry classes, memory admission waits, upstream throttles, disk headroom, verified publications/hour, and rolling observation-window totals. Log model/effort/cost evidence without credentials, complete prompts, transcripts, or note bodies in general operational logs.

Choose the highest sustainable concurrency that meets quality, resource, and reliability gates. Promote server High only with that evidence. Keep Medium and other model/prompt experiments outside this installation's default production route until separately qualified.

Completion: the operational tests pass and each promotion claim has its required evidence. If human review is pending, finish installable code and reversible deployment preparation, keep the approved route active, and report the candidate as awaiting review rather than approved.

## Phase 5: packaging, installation, backups, and rollback

Reconcile source changes with `deploy/notes-only/prepare-runtime.mjs`. It currently rewrites bundled runtime code through compatibility patches. Editing TypeScript alone may not change the installed behavior. Update or retire obsolete patches coherently, test installation idempotence, and verify that the packaged runtime exposes the new coordinator and feature flags. Record source commit, bundle hash, contract/profile identity, and runtime version.

Discover current package scripts rather than assuming they are unchanged. Existing checks include `npm run test:notes-only`, `npm run test:notes-vm`, `npm run notes:package`, lint, and TypeScript checking. Run affected checks and the emitted bundle/installer tests. An opt-in live verifier may mutate locks or interrupt the supervisor; use its documented maintenance conditions.

Upgrade under the existing pause/locking mechanism after draining active work. Install to persistent storage, leave the default system Node and unrelated applications intact, and use the host's supported startup hook. Restore watchdog ownership only after startup health and state reconciliation succeed. Cron was previously verified; full host replacement recovery was not.

Replace repeated complete backup scans with a durable incremental queue/journal plus periodic full integrity audits. Derive pending backup work from durable accepted-artifact state so a crash between artifact acceptance and journal append is repairable. Verify decompression, size, and hashes; skip incomplete artifacts; preserve originals on backup failure. Reclaim sources/orphans only after their defined completion and retention checkpoints. Keep credentials and runtime session state out of shared backups.

Rollback must restore executable code without losing newer committed work. Prefer a compatibility flag or queue export/adaptation for the old runner. Test that rollback path against the migrated schema. Restoring an old SQLite snapshot blindly can forget later publications and artifacts. Retain schema/version information and recovery records so either runner can reconcile verified durable output.

Completion: a compatible coordinator is installed, its active route is explicitly identified, restart/backup/rollback checks pass, and continuing progress is visible. Candidate promotion and 24-hour observation remain separate deliverables until completed.

## Files and references for implementation

Repository reference: `https://github.com/aoppenh1-afk/yutorahv2`. The local pilot recorded commit `ae7c112d61a5b6a2e9900063ceb5d7c327fa4751`; compare it with the VM source rather than resetting the VM to it.

- `packages/notes-only/src/queue.ts`: queue and recovery behavior.
- `packages/notes-only/src/pipeline.ts`: source staging, durable backup, publication.
- `apps/notes-only/src/cli.ts`: generation wiring, locks, commands.
- `packages/opencode-acp/src/runtime.ts`: pinned model/runtime and ACP reference.
- `packages/transcription/src/notes.ts`: full prompt, structural validation, repair, profile identity.
- `packages/transcription/skills/lectern-notes/SKILL.md` and `lectern-transcription/SKILL.md`: complete contracts used by the pilot.
- `lib/official-transcript.mjs` and `lib/tidb-notes-store.ts`: source fetching and verified storage.
- `deploy/notes-only/`: pool, supervisor, installers, compatibility patches, backup, and VM verification scripts.
- `docs/notes-only-vm.md` and `docs/notes-only-pipeline.md`: prior installation and operations. Their dated claims require current verification.
- `docs/notes-speed-research.md`, `docs/notes-batching-research.md`, and `docs/notes-scale-strategy.md`: background and limited prior experiments.
- `benchmarks/notes-inference-20261014/`: frozen pilot sources, contracts, results, quality observations, and the sequential server example, if transferred.

The October 14 benchmark directory was uncommitted in the Mac workspace when this handoff was written. Do not assume it will exist after a Git clone on the VM. The summary in this document is enough to guide implementation; raw artifacts require a separate transfer or a new VM experiment. A lone Markdown file does not carry source code, frozen transcripts, credentials, or executable binaries.

Official server reference: [OpenCode server documentation](https://opencode.ai/docs/server/). Check the pinned binary's live schema and current free-model eligibility before requests. Stop if the permitted zero-price route is unavailable; leave jobs and artifacts recoverable.

## Final report required from the VM agent

Report the VM/project identity, source and installed bundle versions, active model/runtime/effort, stage worker settings, actual tested concurrency, migration preservation counts, test and recovery results, private log/manifest locations, verified publication counts, observation duration, and measured throughput. State which quality and rollout gates remain pending. Document start/pause/resume/status/backup/rollback commands for the actual installation.

Preserve the existing TiDB spending cap and published rows. Keep credentials private. Changes to website deployment, replacement of conflicting published notes, external paid resources, or provider-limit bypasses are outside this upgrade.
