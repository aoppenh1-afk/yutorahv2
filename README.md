# YUTorah Study

A responsive reading and listening interface connected to YUTorah's public library. All featured shiurim, teacher profiles, series, topic counts, daily learning, audio, and source materials come from live YUTorah endpoints. Google sign-in syncs your private study library across devices and enables new-shiur notifications. Saved shiurim, playlists, listening history and progress, notes, the queue, follows, searches, learning activity, and playback preferences use account storage with an offline device copy.

Teacher notifications use a dedicated Supabase Free project and an hourly schedule. See [setup, operation, and iPhone installation](docs/teacher-notifications.md). This service adds no Cloudflare usage.

## Run

The [staged notes pipeline](docs/notes-only-pipeline.md) generates written shiur notes from complete official VTT. It replaces the former audio-transcription worker and operator. Use `npm run notes:only -- help`, `npm run test:notes-only`, and `npm run test:notes-vm`. The supplied written-shiur skill is the generation contract; published notes are preserved across profile changes.

Existing transcript/archive readers remain for previously published content. The public website uses
`TRANSCRIPT_DATABASE_URL` using a read-only role.
Completed transcripts remain available independently of the notes worker. Hosts that use the HTTP reader can instead configure
`TRANSCRIPT_API_URL` and `TRANSCRIPT_API_TOKEN` as described in the operations guide.

The **Sources** tab checks official or archived transcripts and published notes.
It verifies spoken references and distinctive readings against Sefaria, with
separate switches for links and source sheets under Settings. The sheet opens in
Hebrew with an optional English toggle. Download formats and customization are
behind Download; selection, ordering, notes, and manual corrections are in the
options menu. See [configuration, verification policy, and limitations](docs/sefaria-sources.md).
The `Prepare mekoros` GitHub Actions workflow can prepare sheets every 30 minutes
using `SOURCES_DATABASE_URL`, without running an AI model or using the notes VM.
See [runner setup and activation](docs/sefaria-sources.md#prepare-sheets-on-github-actions).

Requires Node 22.13 or newer.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

For the production Worker runtime (uses the same local D1 state as migrations):

```sh
npm run db:migrate:local
npm run build
npm run start -- --port 3001
```

After rebuilding, restart the production preview process. Wrangler can retain old hashed module references when a build replaces its output in place.

## What works

- Search autocomplete shows up to five matching shiur titles while typing,
  alongside teacher, topic, and series suggestions. Strong directory matches
  come first. Selecting a title opens its shiur; Enter still submits a full search.
  [Implementation, research, and database setup](docs/search-autocomplete.md).
- Submitted searches and live suggestions understand typos, transposed letters,
  incomplete words, missing/extra spaces, and common English/Hebrew/transliteration aliases. Teacher
  names resolve only when unambiguous. Ranking, highlights, directory browsing,
  saved-library search, and search within results use the same matching rules.
- Metadata search learns spelling candidates and short phrases from actual indexed
  titles. New titles extend the vocabulary automatically; a resumable
  `npm run search:index` command builds coverage across the upstream archive.
- Removable filters, highlighted matches, description excerpts around search terms, and global ordering of completed result sets by relevance, date, length, or title.

- Search the upstream index across titles and indexed metadata, with teacher,
  topic, series, format, language, and duration filters. Examples:
  `teshvu by Rabbi Hershl Schact under thirty minutes`, `rambm hilch teshuv`,
  and `How can I imprve my pryaer on Shabos?`.
- Parse searches such as “teshuva by Rabbi Hershel Schachter under 30 minutes”; show the interpreted filters. Common question phrasing maps to disclosed topics or keywords.
- Empty searches can recover related matches by omitting one secondary word while
  preserving recognized subjects, numbers, and filters. Results disclose when this
  happens. Ranking favors complete subject coverage and nearby title matches.
- Browse teachers, series, topics, editor selections, recent additions, and daily learning.
- Resume unfinished learning directly from Discover, or revisit each recording's progress in Learning history.
- Explore trending shiurim for 24 hours, week, month, year or all time, ranked by public lifetime views within each upload cohort. Resumable indexing reports incomplete coverage and caches completed charts. See [trending behavior and warm-up](docs/trending.md).
- Follow teachers, topics, and series; filter recommendations to a time budget. Related learning fetches additional recordings from the current shiur's series, topics, and teacher, with a reason for each recommendation.
- Play recordings while navigating; seek, change speed and volume, manage the queue, set a sleep timer, and resume listening.
- Save shiurim and create and edit playlists, with account sync when signed in and device storage when signed out. Removal actions support undo.
- Open available videos and original source materials. Copy links to a shiur or a playback timestamp.
- Keyboard controls: Command/Ctrl+K for search, slash to search, and space for playback outside editable controls.

## Integration boundaries

`lib/yutorah.ts` adapts `https://yutorah.org/api/`. Routes under `app/api` cache public responses, bound query sizes, normalize upstream fields, and return friendly failures. No YUTorah credentials or private API keys are needed.

Search now checks every upstream candidate page automatically and stores a bounded pass at a time in managed PostgreSQL on Vercel, or D1 on Cloudflare. The first pass for a broad query can take a minute or more; the entire unfiltered archive can take much longer. The UI labels interim counts and order as provisional, supports pause/resume, and reports an exact filtered count only after the pass completes. Changed upstream totals, duplicate/missing candidates, and failed pages never silently become a completed search.

Completed candidate sets are cached for one hour after completion. Unfinished passes can resume for up to 24 hours. Duration, language, format, date, exact phrase, excluded words, title scope, and ordering operate over the same stored candidate set. Changing those refinements reuses the candidates. Keyword, teacher, topic, or series changes identify a different candidate set. Sorting and pagination apply to all matches in the completed set, including matches originally on the last upstream page. This is a query-specific candidate index, not a permanent mirror of all YUTorah content.

Natural queries support English number words, time budgets such as "I have half an hour", duration ranges, newest/oldest/shortest/longest ordering, relative dates such as "last year", and conversational requests. A shared domain model connects everyday requests to related Torah concepts: managing anger can find kaas, coping with loss can find aveilus, and stopping gossip can find lashon hara. Specific subjects and explicit filters are preserved, connecting words are optional, and direct wording ranks before related concepts. Interpretations and related topics are shown with the results; this parser is deterministic rather than an LLM.

Typo/prefix retrieval uses YUTorah's existing Solr index. The transcript panel
defaults to tolerant matching and still offers exact phrase and exact words.
Existing transcript installations must apply the owner migrations in `db/transcription/` before
restarting the upgraded read-only search service. Research, matching rules, and rollout
details are in [the search architecture guide](docs/search-architecture.md).

Local setup runs `npm run db:migrate:local` before starting the app. D1 schema lives in `db/schema.ts`; reviewed, append-only migrations live in `drizzle/`. Sites applies those migrations to its hosted DB binding when publishing. The operator title-transfer endpoint requires both explicit enablement and a secret; it is disabled by default and switched off after migration. Credentials stay on the server.

Search does not invent transcripts or answers to religious questions. Metadata search uses the available upstream index; the transcript panel searches only completed, timestamped transcripts from the PostgreSQL worker. Videos and materials appear only where supplied by YUTorah. The app uses its own Google/Supabase accounts rather than YUTorah user accounts. Signed-in libraries sync privately across devices; localStorage keeps the device copy and pending offline edits. Clearing site storage removes unsynced edits but does not delete the cloud library. See [account library sync](docs/account-library-sync.md) for storage limits, conflict handling, privacy, and validation.

This is an independent interface. It does not replace the existing yutorah.org domain or imply a new official Yeshiva University service.

## Design references

The September 2026 redesign uses a white sidebar, cobalt navigation, larger typography, a Jerusalem image, authentic teacher portraits in their original colors, and colorful collection covers. A floating player keeps playback controls available. Spotify's library patterns, Apple Music's shelves and expandable MiniPlayer, TorahAnytime's follows, and OU Torah's daily series informed the navigation and discovery flows. [Research, implementation choices, and the generated image prompt](docs/redesign.md) are documented together.

The October redesign adds a dedicated mobile Torah library with YUTorah’s original wordmark, prominent search and archive totals, genuine teacher portraits, readable shiur lists, native view tabs, and a full-screen player. The wider layout shares its navy palette and editorial hierarchy. [Mobile research, implementation, and validation](docs/mobile-redesign.md) records the changes and independent review.

## Validation

```sh
npx tsc --noEmit
npm run lint
npm run audit
npm run test:search
npm run test:learning
npm run test:api
npm run test:sources
npm run test:performance
# Use a disposable PostgreSQL database; runs the database/recovery tests:
TEST_DATABASE_URL=postgresql://USER@127.0.0.1/worker_test npm run test:content
TEST_DATABASE_URL=postgresql://USER@127.0.0.1/worker_test npm run test:maintenance
npm run test:notes-only
npm run test:notes-vm
npm run performance:fixtures
npm run build
npm run performance:budgets
# Browser player regressions use the built website and an isolated local state directory:
npx playwright install chromium
npm run test:player
# Start the production server in another terminal first:
npm run test:live
```

`TEST_ORIGIN` can point the live checks at another deployment. These tests intentionally use actual YUTorah content and require network access. They cover live homepage content, compound metadata search, pagination, question interpretation, audio/source material availability, and invalid input. See `QA.md` for browser checks and remaining release conditions.

Implementation status, measurements, privacy-safe diagnostics, supported library limits, and additive release ordering are recorded in [the performance implementation notes](docs/codebase-performance-implementation.md). PostgreSQL fixture setup provisions `pg_trgm` once before parallel tests; use a disposable owner connection with permission to create fixture schemas and roles.

## Publishing

The public production website is **https://yutorah.vercel.app**, deployed by the GitHub integration for `aoppenh1-afk/yutorahv2`. Its Vercel project uses `vercel.json` and `npm run build:vercel` to generate Nitro server functions and static assets. Configure server-side secrets `SEARCH_DATABASE_URL` and `TRANSCRIPT_DATABASE_URL` in Production and Preview. Search uses `yutorah_search_app` in the separate Neon Free project `yutorah-titles`, with access only to its `yutorah_search` schema. Transcripts and notes use `yutorah_reader` in the Neon Free project `yutorah-transcription`, with read-only access to content tables. Builds compile without database access. Before activating a release, apply owner migrations with `npm run search:schema:migrate`; Vercel then runs the separate read-only `npm run search:schema:check` after compiling and blocks activation if the schema is incompatible. The public website reads completed transcripts independently of the transcription computer. The notes coordinator uses its separate TiDB writer for verified note publication and authorized hash-guarded replacements; it does not generate new audio transcripts. See [the verified database split](docs/search-storage-research.md#completed-database-split) for migration evidence, measured storage, backups and rollback requirements.

The complete learned title index is stored in PostgreSQL. Compact phrase keys are derived from the vocabulary; word deletion keys use PostgreSQL's inverted index. This preserves the audited spelling candidates without storing millions of repeated phrase-key rows. See [the PostgreSQL migration procedure](docs/search-architecture.md#vercel-postgresql-migration) for schema setup, source export, and hash verification. Local development and Sites keep their native D1 binding. Vercel's old Cloudflare credentials and transcript tunnel settings are unnecessary. Verify the deployed homepage, assets, typo searches, and transcripts after publishing.

The separate private Sites deployment is configured in `.openai/hosting.json`; it is not the public Vercel website. Reuse that exact project ID when working on Sites. Push the exact source commit, save its built version, privately deploy it, and repeat the live checks against the returned deployment URL. Do not create a duplicate Site.
