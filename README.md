# YUTorah Study

A responsive reading and listening interface connected to YUTorah's public library. All featured shiurim, teacher profiles, series, topic counts, daily learning, audio, and source materials come from live YUTorah endpoints. Personal learning data stays in the browser.

## Run

Requires Node 22.13 or newer.

```sh
npm ci
npm run dev
```

For the production Worker runtime:

```sh
npm run build
npm run start -- --port 3001
```

After rebuilding, restart the production preview process. Wrangler can retain old hashed module references when a build replaces its output in place.

## What works

- Search the upstream index across titles and indexed metadata, with teacher, topic, series, format, language, and duration filters.
- Parse searches such as “teshuva by Rabbi Hershel Schachter under 30 minutes”; show the interpreted filters. Common question phrasing maps to disclosed topics or keywords.
- Browse teachers, series, topics, editor selections, recent additions, and daily learning.
- Play recordings while navigating; seek, change speed and volume, manage the queue, set a sleep timer, and resume listening.
- Save shiurim, create and edit playlists, and keep timestamped notes on this device. Removal actions support undo.
- Open available videos and original source materials. Copy links to a shiur or a playback timestamp.
- Keyboard controls: Command/Ctrl+K for search, slash to search, and space for playback outside editable controls.

## Integration boundaries

`lib/yutorah.ts` adapts `https://yutorah.org/api/`. Routes under `app/api` cache public responses, bound query sizes, normalize upstream fields, and return friendly failures. No YUTorah credentials or private API keys are needed.

YUTorah currently accepts teacher, series, and subcategory filters at its search endpoint. Its duration, language, and media filter parameters did not filter results in live testing, so this app checks those fields across batches of three upstream pages. The interface distinguishes loaded filtered matches from the upstream total and supports loading more until all pages are checked.

Search does not invent transcripts or answers to religious questions. It searches the available upstream index and visibly interprets supported phrases. Videos and materials appear only where supplied by YUTorah. The app does not synchronize with YUTorah user accounts; saved items, notes, playlists, and progress use localStorage. Clearing browser storage removes that personal data.

This is an independent interface. It does not replace the existing yutorah.org domain or imply a new official Yeshiva University service.

## Design references

The layout uses persistent navigation, restrained YU blue, white space, serif editorial headings, and compact learning controls. The research included [Linear's interface refresh](https://linear.app/now/behind-the-latest-design-refresh) for navigation and hierarchy, and [Spotify's listening controls](https://newsroom.spotify.com/2025-09-05/new-user-controls-personalize-listening/) for filtering and player continuity. No emojis or generated decorative imagery are used.

## Validation

```sh
npx tsc --noEmit
npm run lint
npm run build
# Start the production server in another terminal first:
npm run test:live
```

`TEST_ORIGIN` can point the live checks at another deployment. These tests intentionally use actual YUTorah content and require network access. They cover live homepage content, compound metadata search, pagination, question interpretation, audio/source material availability, and invalid input. See `QA.md` for browser checks and remaining release conditions.

## Publishing

Sites is configured in `.openai/hosting.json`. Reuse that exact project ID. The current account connection returns `NOT_FOUND` for the Site created during this task; publication has not succeeded. Restore access to that Site, then push the exact source commit, save its built version, privately deploy it, and repeat the live checks against the returned deployment URL. Do not create a duplicate Site to work around the access failure.
