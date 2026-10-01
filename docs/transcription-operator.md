# Transcription operator

The VM hosts a private operator GUI on **127.0.0.1:8766** and a read-only
transcript, notes, and search endpoint on **127.0.0.1:8765**. The public website
keeps its existing hosting and metadata search. Its shiur reader now displays the
completed transcript and generated study notes, and its spoken-word search retains
main's typo and partial-word matching.

## First batch

1. Open the VM's operator interface. For a remote VM, keep this SSH tunnel open:

   ```sh
   ssh -N -L 8766:127.0.0.1:8766 USER@VM
   ```

   Then open `http://127.0.0.1:8766` on your laptop. The collaborative preview can
   also use environment port 8766 when its connection to this VM supports it.
2. The workspace opens directly. There is no operator password or login form;
   access uses your VM session or the SSH tunnel.
3. Click **Connect Google**. The GUI pauses its worker first and shows a callback
   tunnel command and the exact Google URL. Run that second SSH tunnel on your
   laptop, open the URL, and leave the GUI open until it reports connected. Stop
   the callback tunnel afterward. **Check saved sign-in** checks credentials
   without opening a new login flow.
4. Select a model advertised by your account and save settings. Automatic notes
   are enabled initially; you can disable them. The model and both complete skill
   contracts are pinned when their respective jobs are queued.
5. Search the teacher or series directory. A series can optionally be restricted
   to a specific teacher. Set a **total recording budget** (default 10). This is
   a cap on imported jobs for that selection, rather than 10 more every poll.
6. Add or enable the selections you want, then click **Import next batch**. Each
   pass requests at most two pages per enabled selection, through YUTorah's
   teacher/series filters. It verifies the returned IDs before accepting audio.
   Source selections can be saved before Google is connected. Importing waits
   for sign-in and a saved advertised model, so jobs cannot accidentally pin an
   unavailable default model. Importing itself does not download audio.
7. Click **Start queue**. Up to five Antigravity sessions run in parallel by
   default. Separate recordings, long-recording chunks, and study notes share
   that limit. The GUI shows active sessions and each job’s statuses.
   **Pause queue** aborts owned work, saves reusable chunks/cleaned text, and
   requeues interrupted jobs. **Pause selection** stops that source's discovery
   and future claims; a job already running can finish.
8. Click **Read** to inspect or download a completed transcript or notes. Check
   a real short recording for coverage, Hebrew/Aramaic spelling, and timestamps,
   then test a longer recording and a service restart. Retry a failed transcript
   or failed notes separately using its corresponding action.

The suggested teacher is **Rabbi Aryeh Lebowitz (80714)**; YUTorah has a second,
smaller **Rabbi Aryeh Leibowitz (81310)** entry. **Ten Minute Halacha (4233)**
contains other teachers too, so use its teacher restriction for only Lebowitz's
shiurim. These directory IDs were verified against live YUTorah records. A
teacher and an overlapping series share jobs for the same source/version.
No selection starts processing until enabled and the worker is started.

Increasing a budget resumes the saved page and offset. When a series's teacher
restriction changes, its cursor and queue associations reset; its old completed
transcripts remain readable. An unowned or paused-source job is not claimed by
the GUI worker. There is no automatic whole-archive ingestion.

## Install a built revision

Use Node >=22.13, PostgreSQL, FFmpeg, curl, unzip, and OpenSSL. Build as the
normal deployment user first:

```sh
npm ci
npm run worker:build
sudo bash deploy/transcription/install-runtime.sh
sudo env OPERATOR_NODE="$(command -v node)" bash deploy/transcription/install-operator.sh
```

The runtime installer tries Google's primary download and its edge mirror; both
must match the pinned SHA-256. It refuses to replace an existing runtime pair.
Run `probe` under the worker account before signing in. The operator installer
copies the compiled code, static GUI, skills, and migrations into
`/opt/yutorah-operator`, installs JS runtime dependencies, and copies the chosen
Node binary into its `bin/` directory. It creates dedicated Unix/PostgreSQL
accounts, applies migrations, and sets the read-only role's grants.

| Location | Purpose |
| --- | --- |
| `/opt/yutorah-operator` | Installed source-independent application |
| `/opt/antigravity-acp/1.2.1` | Verified Google runtime pair |
| `/etc/yutorah-operator.env` | Database/runtime settings |
| `/etc/yutorah-search.env` | Read-only database settings and website token |
| `/var/lib/yutorah-worker/profile` | Private Google credentials |
| `/var/lib/yutorah-worker/scratch` | Disposable in-flight audio/runtime directories |

On a systemd VM, the installer starts **yutorah-operator** and
**yutorah-content**. The operator conflicts with the legacy **yutorah-worker**
unit: run one worker owner, not two. The worker's PostgreSQL leadership lock
also prevents concurrent owners.

The current development VM has no running systemd. The installer starts
background processes, with PID files in `/run/yutorah-{operator,content}.pid`
and logs in `/var/log/yutorah-{operator,content}.log`. After a VM restart, start
PostgreSQL and then run:

```sh
sudo bash /opt/yutorah-operator/deploy/transcription/start-operator.sh
```

On a systemd deployment, use `systemctl` for lifecycle and `journalctl` for logs.
On this container VM, stop the `runuser` supervisor PID from the matching PID
file; it forwards termination to its Node process. Wait until the ports close
before replacing installed files or removing a stale PID file.
The installer intentionally refuses an existing destination. For upgrades,
stop both services, replace compiled code/GUI/skills and package files, install
dependencies, run `migrate`, and restart. Preserve environment files, profile,
and database. Database migrations are append-only.

## Connect the website

Put the read-only endpoint behind HTTPS (for example the existing Caddy
configuration), and configure the existing website with server-side
`TRANSCRIPT_API_URL` and `TRANSCRIPT_API_TOKEN` from the search environment.
The operator is a password-free VM-local application. Keep it on loopback;
its request checks reject other hostnames, cross-origin calls, and forwarded
proxy traffic. The public website uses only the separately authenticated reader.
A managed website cannot reach this VM's loopback address; it needs the deployed
HTTPS endpoint.

Migration **004_operator_notes.sql** follows the search branch's migration 003.
The new content reader needs SELECT on `transcripts`, `notes_jobs`, and
`transcript_notes` in addition to the previous search tables. Migration 004
adds these grants for the standard existing `yutorah-search` role; the
installer grants all six reader tables for a new installation. Custom roles
need equivalent grants.

The content endpoint returns only the active, fully published transcript.
Notes are tied to that exact transcript version, so an old notes job can never
appear beside a newer transcript. Raw timed segments remain available while
notes are queued or fail. Website requests carry the read token only on the
server, and all content/search responses use `Cache-Control: no-store`.

## Parallel processing and long recordings

`ACP_CONCURRENCY=5` in `/etc/yutorah-operator.env` sets one shared limit for
all transcription and notes requests. It also bounds the number of leased
recordings/notes jobs. Values from 1 to 20 are supported; restart the operator
after changing it. Pause drains all sessions and keeps accepted database
checkpoints. Only one worker owns the account and scratch directory.

Lectern’s audio preparation is preserved: recordings over 16 MiB are split
into size-budgeted cores, moved to quiet points within 15 seconds of the
planned boundary, and exported with up to five seconds of overlap on either
side. AAC/ALAC samples are copied; other codecs are converted to AAC with
conservative size planning. Every exported file must fit the 20 MiB native
audio limit. Results are checkpointed as they finish, merged in recording
order with global timestamps, and deduplicated only at chunk boundaries.
Completed chunks are reused after a restart. Source and exported audio are
deleted when each attempt ends.

## Lectern generation and storage

Both skills are copied verbatim from Lectern commit
`1b1032f96039aaac63261afc84a86cd20ce63867`; each copy has a provenance file.
The transcription request attaches native audio and includes the full skill.
The generation sequence follows Lectern's Swift `GenerationService` and
`Prompts`: clean the full transcript first, persist it, generate a grounded
Markdown outline, normalize presentation, validate structure, and allow one
repair. The optional diagram is omitted for this text-only first release.
Native tool calls and permission/input requests are rejected for both stages.

Notes have their own durable queue, profile, lease, cancellation, and retry.
A failed notes attempt retains its cleaned transcript. It neither invalidates
the published timed transcript nor downloads audio again. Generation inputs
are bounded by ACP's 1 MiB text-request limit; an oversized source fails visibly
rather than being silently truncated. Structural checks are not a substitute
for a human check of real transcription or notes quality.

Downloaded audio, exported chunks, and per-request native runtime files are
removed after every attempt in `finally`, including success, cancellation,
download errors, and provider failures. Accepted chunks and final artifacts are
stored in PostgreSQL, not as audio files. On worker startup, abandoned owned
`job-*` and `acp-*` scratch directories are swept. Google profile credentials
are preserved. Checkpoints can eventually be pruned for completed jobs; see
the operations guide. PostgreSQL backups remain necessary.

## Validation

```sh
npm run worker:build
TEST_DATABASE_URL=postgresql://USER@127.0.0.1/worker_test npm run test:worker
npm run test:search
npm run test:learning
npx tsc --noEmit
npm run lint
npm run audit
npm run build
TEST_DATABASE_URL=postgresql://USER@127.0.0.1/worker_test npm run test:pipeline
```

Use a disposable test database. The suites verify selection budgets, scope
validation, shared jobs, narrowing a series, independent generation/retry,
lease fencing, cancellation, audio deletion, actual worker orchestration,
reader authentication, and the compiled website/search/database path.
Only the model boundary uses a deterministic ACP fixture. The VM's real
`probe` verifies the installed native handshake; real transcription, Google
quota, credential renewal, and notes quality require the user's Google sign-in.
