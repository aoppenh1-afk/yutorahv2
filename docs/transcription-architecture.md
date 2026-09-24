# Antigravity transcription worker architecture

Research baseline: 2026-09-24. Lectern `main` was cloned and inspected at
[`793ede35807b02063f262592a426bd604a61ca21`](https://github.com/aoppenh1-afk/Lectern/tree/793ede35807b02063f262592a426bd604a61ca21).
This report precedes the server implementation. No authenticated transcription has
been performed with the user's Google account in this workspace.

## 1. The actual Lectern flow

`ShiurAutomationService.downloadAndImportLecture` calls
`YUTorahSourceProvider.resolveMediaURL` → `YUTorahMediaResolver`: prefer a supplied
enclosure; otherwise extract the MP3 from the classic lecture iframe, repair
`-.mp3`, and upgrade HTTP to HTTPS. `RemoteAudioDownloader` downloads and validates
audio; `LectureImportService` records source metadata. Automation later calls
`TranscriptionService.enqueue`.

The website adapter also accepts the upstream `shiurdownloadurl` field alongside
`downloadURL` and `shiurFileURL`; the Linux resolver checks all three before the
classic iframe fallback.

`TranscriptionService.performJob` selects Antigravity and calls
`transcribeExternally`. Its persistent job ID survives failed attempts. Completed
Antigravity jobs are rebuilt from checked chunks before being trusted after a crash.
An explicit fresh transcription gets a new checkpoint identity.

`ExternalTranscriptionEngine` selects `AntigravityTranscriptionAdapter` and disables
its outer three-attempt retry loop for Antigravity. The adapter hashes the source
audio and full skill, reads saved ranges/results, prepares unfinished audio, then
schedules bounded parallel chunks. Each accepted result is saved **inside its
chunk task before returning**, including out-of-order completions. Failure cancels
siblings; only a complete set is merged in original chunk order.

Each chunk calls `AntigravityACPClient.run` through the shared `AISessionPool`
(default **3**, configurable 1–20). After acquiring a permit, it owns a fresh ACP
process and temporary workspace. The connection is restricted before initialization.
It initializes ACP v1, authenticates with `oauth-personal`, creates a session with
no MCP servers, selects advertised `default` mode, and requires the exact model
from the advertised model selector. Current Lectern default: `gemini-3.8-flash-high`.
The full skill is inlined verbatim. Audio is a base64 **native audio content block**.

Despite the skill's support for JSON, the current adapter explicitly requests
**timestamped plain text**, not JSON. Lectern parses that into structured segments.
Preserve this successful prompt/output path. Speakers are optional; script detection
marks mixed English/Hebrew segments with no single language, rather than claiming
to distinguish Hebrew from Aramaic from script alone.

Preparation passes files ≤16 MiB directly. Larger files use size-based equal cores,
5 seconds of overlap on each side, and quiet boundary search within ±15 seconds
(RMS smoothed within 0.35 seconds). AAC/ALAC can pass through to M4A; other audio is
converted to AAC, budgeting at least 48,000 bytes/second. Attachment ceiling is
20 MiB, with 64 KiB planning headroom. Export sizes are checked. Saved ranges let
resume skip both ACP requests and exports for successful chunks.

Timestamp validation checks raw order and duration with 2 seconds of rounding
tolerance before clamping. Segment ends derive from the next start or chunk end.
Overlap merge compares up to 80 normalized boundary tokens; an exact suffix/prefix
match needs ≥3 tokens or ≥12 characters. It trims only that boundary overlap and
normalizes the timeline, preserving later repetition.

Only process closure and timeout receive one fresh-session retry, after 1 second
outside the permit. The deadline is 3× chunk duration, clamped to 15–120 minutes.
Tools, permissions, user-input requests, malformed output, and auth failures do
not receive automatic chunk retries. ACP requires `end_turn`; transcript output
is limited to 4 MiB and protocol lines to 8 MiB. Thought output is ignored.
Permissions are denied; tool notifications stop the attempt. These controls detect
and terminate tool work; **they do not sandbox the runtime's native tools**.

Inspected implementations: the seven requested generation/transcription files,
audio preparer and merger within `ExternalTranscriptionEngine.swift`, YUTorah media
resolver/source provider, downloader/import/automation path, and regression tests
`AntigravityACPTests`, `AISessionPoolTests`, `TranscriptionConcurrentACPTests`,
`TranscriptionChunkConcurrencyTests`, `TranscriptionReliabilityTests`. Read ADR 0002,
the September 16 upstream audit, and the transcription reliability plan. The plan's
early findings describe pre-fix behavior; the current code has the fixes above.

## 2–4. Reuse and rewrite

Copy the entire skill verbatim with provenance and its MIT notice. Port pure
planning, parsing, overlap merging, fingerprint inputs, protocol policy, and test
scenarios. Keep skill loading independent of worker orchestration.

Rewrite process ownership, filesystem permissions, audio inspection/export, queue,
storage, shutdown, and configuration for Linux/Node/PostgreSQL. FFmpeg/ffprobe
replace AVFoundation; no local speech model is involved. There is no need for Swift,
a GPU, desktop UI, Keychain, or local-provider fallback.

## 5–6. Linux runtime and headless sign-in

The [ACP registry entry](https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json)
currently publishes Google **1.2.1** for Linux x86-64 and ARM64, with command
`agy_acp_server.par --uid=`. Google hosts both archives under
`https://dl.google.com/agy-extensions/releases/linux/`. The downloaded x86-64
archive contains exactly `agy_acp_server.par` and `localharness_external`.
A local unauthenticated initialize probe succeeded and identified `antigravity-acp`
version `1.2.1`, protocol 1, native audio, `oauth-personal`, resume, and logout.
Both archives were downloaded, their two-member contents checked, and SHA-256 hashes
pinned in the installer. Execution on ARM64 is still a deployment gate.

Use an isolated persistent `GEMINI_HOME`, its `antigravity-acp/settings.json` with
`{"auth":{"type":"oauth-personal"}}`, `AGY_ACP_FORCE_FILE_STORAGE=1`, and
`ANTIGRAVITY_HARNESS_PATH` pointing to the companion from the same release. These
environment settings come from Lectern's working runtime integration and were
used in the successful Linux initialize probe; they are not invented HTTP APIs.
Give each process its own temporary extraction directory and an empty workspace.
Pass an allowlisted environment, excluding database passwords and API-key modes.

Run a separate interactive `auth` command over SSH as the worker user. Accept only
the expected Google authorization URL and loopback redirect. Display it only to
the terminal, never to service logs. Forward the runtime-selected callback port
from the operator's laptop with `ssh -N -L PORT:127.0.0.1:PORT user@vm`, then open
the URL locally. Google redirects through SSH to the runtime's existing callback
listener. The runtime performs the OAuth exchange and owns credential persistence
and refresh; the worker never reads or copies token values or implements renewal.

This tunnel preserves the observed loopback OAuth protocol. It is an operational
adaptation, not a claimed Google device-code/headless ACP feature. Google's ordinary
CLI remote-auth documentation is not evidence of ACP support. Full sign-in,
restart persistence, concurrent token refresh, and eventual renewal must be verified
on the deployed account. Background workers fail with `auth_required` instead of
waiting indefinitely for a browser. Revocation requires an operator to sign in again.

## 7–11. Modules, data, lifecycle, and recovery

Keep the existing web app in place. Add `apps/worker` plus shared modules
`packages/antigravity-acp`, `packages/transcription`, and `packages/yutorah-core`.
The web app uses Cloudflare D1 for metadata search; PostgreSQL is the transcription
store. The worker's paginated discovery loop creates jobs automatically, and a
read-only VM search process serves the website through a same-origin bridge. No
implicit D1 migration or public queue writer is needed.

PostgreSQL stores source shiur metadata, versioned jobs, immutable accepted chunk
payloads with SHA-256 digests, versioned transcripts, and timestamped segments.
Jobs include status, priority, attempt, available time, lease token/expiry,
cancellation request, timestamps, sanitized error code, model, skill hash,
pipeline version, audio digest, manifest and manifest digest. Job configuration
pins the full skill content at enqueue time so upgrades cannot change an active job.
Original transcript text is never replaced with search-normalized text.

Queue states: `queued → downloading → preparing → transcribing → merging → completed`;
terminal alternatives are `failed` and `cancelled`. Claim a bounded number with
`FOR UPDATE SKIP LOCKED`. Heartbeats extend leases; every mutation checks the lease
token and expiry. Expired active jobs can be reclaimed for up to five attempts;
an expired fifth attempt becomes `failed` until explicit retry. User cancellation stays
cancelled; service shutdown releases work to the queue. Final segments and completed
status commit in one transaction. A failed chunk preserves accepted siblings.

Initially one active worker owns the account-wide pool (default 3); a PostgreSQL
advisory leadership lock and systemd prevent accidental duplicate worker services.
The queue never loads the archive into memory. Multiple active VM workers would
require distributed session admission and tested partition handling; this foundation
does not claim a multi-VM global limit. One job at a time with parallel chunks is
the conservative default. Backfill inserts jobs in bounded batches with low priority.
The recent catalog scan persists its page cursor and last completed pass, overlaps
the last pass after downtime, and independently revisits page one each deep poll.
The small homepage feed is checked more often; the paginated backstop closes gaps
left by the feed's ten-item limit. Homepage and search records share a publication
revision so their different audio URLs do not create duplicate jobs.

Fingerprint source content (streaming SHA-256), source ID, job ID, model/thinking,
language/speaker options, full skill bytes, runtime version, and explicit prompt,
parser, preparation and merge versions. Do not fingerprint temporary paths or mtimes.
Manifest ranges are validated and hashed. A valid checkpoint must match fingerprint,
index, range, digest and segment schema. Corrupt/missing parts are recomputed;
successful parts survive process and VM restarts. Resume may redownload/hash source
audio, but does not resubmit successful chunks. Changed source bytes invalidate all
affected checkpoints. Database checkpoint-write failure stops the job rather than
pretending its progress is durable on a unattended server.

Persist `{startMs,endMs,text,speaker,language}` segments, complete text, provenance,
duration and schema version. Require timestamps for website transcripts (Lectern's
untimed option is unsuitable for seekable results); preserve its 2-second tolerance.
Silence at the end is valid. Timestamp correctness and syntactic validity do not
prove full audio coverage; multilingual quality remains a live acceptance test.

## 12. Literal search

PostgreSQL is enough initially. Keep a separate normalized search column and GIN
trigram index, plus a `simple` tsvector for token search; optional English stemming
must not transform Hebrew. Normalize Unicode, remove Hebrew cantillation/niqqud,
fold Hebrew/ASCII quotation variants consistently, and normalize whitespace/case.
Do not broadly strip Hebrew prefixes or equate final letters without evidence.

A small explicit, versioned alias dictionary links `chazara ↔ חזרה`,
`Tosfos/Tosafot ↔ תוס׳`, `Rashi ↔ רש״י`, and `migo ↔ מיגו`. Alias expansion is
disclosed and separable from literal matching; it is not automatic transliteration.
Phrase matching uses normalized contiguous text; token matching uses PostgreSQL's
`simple` dictionary. Adjacent-segment search windows preserve phrases crossing a
segment boundary and return the first matched segment's start. Bound input, result
count and query time. Semantic indexing can consume completed transcripts later.
References: PostgreSQL [dictionaries](https://www.postgresql.org/docs/current/textsearch-dictionaries.html)
and [pg_trgm indexes](https://www.postgresql.org/docs/current/pgtrgm.html).

## 13–15. Deployment, security, remaining validation

Use a dedicated Linux user, Node 22+, FFmpeg, PostgreSQL, persistent private profile,
and systemd with `KillMode=control-group`, restart delay, restrictive umask and a
writable state directory. Pin runtime URLs and verified archive digests; keep the
pair together. No in-place update during active sessions. Native child groups get
TERM then KILL, including surviving children after parent exit. systemd also kills
descendants after a worker crash before restarting. Sweep only owned scratch dirs.
Temporary source/chunk audio is removed after each attempt; durable results live
in PostgreSQL. Configure disk, download-size, duration, and queue limits.

Protocol restrictions apply from initialize, reject tools/input/permissions, enforce
limits and successful stop reason, and check isolated configuration for hooks/MCP.
Audio instructions are untrusted content. Runtime code has network and profile
access: protocol controls are not a security sandbox. Use a dedicated VM/account
context, minimal secrets, read-only application/runtime files, and private DB access.
The worker logs only job/chunk IDs, attempts, durations and typed error codes.
Google's runtime may maintain its own private session files; do not promise that
the runtime stores no prompts. Profile retention must preserve credentials while
following supported runtime cleanup behavior; do not edit undocumented token files.

The search process runs under a separate OS/PostgreSQL read-only identity, binds
loopback, and is exposed through HTTPS by the VM reverse proxy. The Cloudflare
website route holds a server-side bearer token and returns bounded transcript
results to browsers; the token never enters the client bundle. Only GET search is
exposed. The search and transcription processes do not share the OAuth profile.

Remaining gates: account login and long-term refresh; current advertised model;
ARM64 execution; multilingual quality and long/sparse audio; FFmpeg AAC differences
from Apple's encoder; memory/disk at concurrency 3; subscription throughput/quotas;
runtime native-tool containment. A cheap/free VM is plausible, not a verified
capacity or pricing promise. Start with measured capacity and throttle archive work.

Implemented stages: (1) protocol/process + pure transcription behavior and skill;
(2) database queue/checkpoints/search; (3) Linux audio and worker orchestration;
(4) CLI, provisioning, process/DB restart regression tests; (5) automatic paged
catalog ingestion and a read-only search bridge with timestamped website results.
Account authentication and live multilingual acceptance remain deployment gates.
