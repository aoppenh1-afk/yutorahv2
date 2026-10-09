# Continue the notes pipeline on this VM

Install and run the attached private notes pipeline package on this managed VM.
The user authorizes a free-only setup. Use the persistent home directory and
outbound connections. SSH is unnecessary.

1. Inspect Node.js, git, the existing OpenCode binary/version, persistent disk,
   and the VM service's supported startup hooks. The package needs Node 22.13+
   and OpenCode 1.18.33. Preserve existing applications and use a separate pinned
   `opencode-notes` binary when necessary.
2. Extract the archive privately and run `bash install.sh`. It installs to
   `~/.local/share/yutorah-notes`. `writer.json` is a database credential; keep it
   mode 600 and omit its contents from logs and chat.
3. Run `./run.sh help`, enqueue 1190357 and 1190833, and run `--limit 2` with the
   correct `--opencode` path. 1190357 is already published and should skip AI.
   Confirm a newly generated note is durably backed up, uploaded, read back, and
   marked completed before its temporary transcript is deleted.
4. Restart the worker to verify recovery and inspect `./run.sh status`. Configure
   the host's supported startup hook, then test that mechanism. If the host offers
   no persistent startup service, report that limitation explicitly.
5. Discover catalog IDs in batches with `catalog --pages 20`, then start
   `run --all --follow`. Catalog and worker mutations share a single-process
   lock, so discover subsequent batches with the worker stopped. Arrange the
   supported scheduler/startup hook to resume both phases as needed. Back up the
   compressed `notes` directory periodically.

Only `opencode/muse-spark-1.3-contributor-free` is permitted. The runtime stops or
backs off if it is unavailable. TiDB Starter `yutorah-notes` already exists in
us-east-1, database `yutorah_notes`, with a $0 spending limit and no card added.
Use the existing insert-only writer credential. Keep that spending cap unchanged.

The Mac session completed one live generation: shiur 1190357, 11,647 bytes of
Markdown compressed to 4,549 bytes. It verified the database round trip, deletion
after publication, crash recovery, and local website display. Full catalog work
has not begun, and the VM's startup persistence is untested.

Website read-only credentials are already saved in Vercel for Production and
Preview. Website code is still in the Mac checkout and needs a deployment; the
attached worker archive does not deploy the website. For details read
`OPERATIONS.md` in the package.

Completion: a new VM pilot succeeds, restart resumes without duplicate generation,
the supported startup hook is tested, compressed backup location is documented,
and ongoing progress is visible. Report any remaining host or free-provider limit.
