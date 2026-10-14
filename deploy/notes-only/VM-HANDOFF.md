# VM operations

The installed runtime is built directly from `apps/notes-only/src/cli.ts`. Build with `npm run notes:package`; install its public package with the existing private writer credential. Operational commands and recovery boundaries are in `docs/notes-only-pipeline.md` (packaged as `OPERATIONS.md`).

Use the private Node binary, pause and drain before installing, and preserve committed queue/artifact state. ACP High is the reference route. The user waived human review and the 24-hour observation on October 14, 2026. Server High uses an exact-profile waiver record and automatically verified 100/500/1,000-note cohorts before continuous production. The selected route is recorded in STATE/route, and persistent STATE/pools.json defaults to 3 fetchers / 4 generators / 1 continuous publisher. Never restore a pre-upgrade queue snapshot over subsequent publications.
