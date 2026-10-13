# Shiur downloads and offline listening

Mobile users who open the root website without an internet connection see Downloads with “No internet connection. Listen to your downloaded shiurim.” A failed reachability check also handles networks that appear connected but cannot reach the website. Cellular internet remains an online connection.

Audio shiur details offer **Download for offline**. **Download file** retains the original file link. Downloads is a tab in the mobile library and an item in desktop navigation. Users can play, resume, search, cancel, retry and remove downloads. Removal stops the recording if it is playing and leaves saved shiurim and listening history intact. An empty offline library explains how to download once back online.

## Storage and playback

- Complete audio responses live in the `yutorah-audio-v1` Cache Storage cache. Metadata lives in the `yutorah-downloads-v1` IndexedDB database.
- Metadata is committed only after the full audio body and offline app shell are saved. Interrupted, cancelled and quota-failed downloads never appear available offline.
- Downloads belong to the browser and device, independently of account library sync. Original media URLs remain in the synced library. No blob URL or downloaded flag is synced to another device.
- The player resolves local audio before using the original streaming URL. The service worker serves byte ranges at `/offline-audio/:id` for native seeking. A blob URL provides local playback if the page is not yet controlled by a service worker.
- On startup, metadata is checked against the audio cache. Missing files disappear from the list. Recent in-flight writes in another tab are protected from orphan cleanup. A broadcast channel refreshes the list after writes from another tab.
- Storage persistence is requested when supported. Browsers can still refuse it, and clearing website data removes downloads. Keep the app open until a download finishes. iPhone Safari and its home-screen app have separate storage.

## Media relay

`GET /api/audio-download?id=:id` resolves the original media URL from the official shiur details. The browser never supplies an arbitrary proxy URL. HTTPS hosts and every redirect are restricted to the known YUTorah audio hosts. The relay checks media type, audio signature and size, then streams the body without buffering the recording on the server. A 256 MiB per-recording limit bounds browser storage and memory. Failed bodies cannot produce completed downloads.

The direct audio host does not currently expose cross-origin read permission. This relay lets the website save the bytes locally. Its bandwidth is part of website hosting usage. Vercel must preserve the streamed response; the route does not return a buffered multi-megabyte payload.

## Offline app shell

The root layout registers `/sw.js` for guests and signed-in users. Push notifications retain their existing handlers. `scripts/build-offline.mjs` follows the emitted client import graph and saves the application modules, framework client references, CSS, local fonts and app icons. Dynamic framework references must be available even when the normal browser cache is empty. It excludes deferred document exporters. Account responses are never cached. Public study content for downloaded shiurim uses a separate cache.

The build prepends an asset list and content version to the emitted worker. Installation saves the public root HTML and all required assets before activating the worker. Offline root visits, including URLs with search or shiur query parameters, use this shell and display Downloads. A marker in the fallback HTML avoids waiting for a connectivity timeout on cold startup. Cached audio is separate from release-version caches, so app releases preserve downloads.

Run `npm run build` for Cloudflare or `npm run build:vercel` for Vercel. The final build step is required; serving `public/sw.js` alone does not prepare an offline shell. Development modules are not cached. Verify offline startup against a production build.

## Design source

The user selected prototype A, an offline notice above the listening list. The three illustrative variants, floating URL-based switcher and decision record are preserved on the local branch `prototype/mobile-offline-downloads`, commit `06b5f38`. They are absent from the production implementation.

The prototype worktree is `/tmp/yutorah-downloads-prototype-parent/app`. Run `npm run dev -- --port 3002` there and open `http://localhost:3002/?view=saved&prototype=downloads&variant=A`. B emphasizes continuing a recording; C groups downloads by teacher.

## Verification

`npm run test:downloads` checks the streaming relay, offline worker and native browser playback in Chromium and WebKit. Browser cases cover downloading, loss of connection, root reload, opening a fresh offline tab, seeking, resume, removal, reconnecting, interrupted downloads and missing cached files. Screenshots go to ignored `outputs/downloads/`.

Also run `npm run test:player`, `npm run test:learning`, `npm run test:api`, `npm run test:account-library`, `npm run lint -- --deny-warnings`, `npx tsc --noEmit` and `npm run performance:budgets` after building. The existing account-library database test requires its external fixture and may skip without it.

Automated WebKit checks cover the Safari engine. A physical iPhone check should still confirm home-screen installation, lock-screen playback and behavior under actual device storage pressure. Deployment is separate from this local implementation.

Verified on 2026-10-13: 30 download tests and all 49 player regressions passed, including durable portraits, offline transcripts, notes-only reading, summaries, existing-download upgrades and cancellation during study-content saving. Learning, upstream API, and account-library checks passed; the external account-library database fixture was unavailable and skipped. Chromium tests clear the normal browser cache before offline reopening. WebKit tests drop real HTTP connections because its automation offline mode can reject service-worker responses. Both Cloudflare and Vercel builds, strict lint, TypeScript and performance budgets passed. The live relay streamed an 8,824,650-byte YUTorah MP3.

## Offline images and study content

Each audio download also saves the available transcript, completed study notes, and YUTorah chapters and summaries in `yutorah-study-v1`. These are public reading responses, stored separately from the app shell. Account endpoints and general browsing responses remain uncached. Missing or queued content, failed responses, malformed JSON and bodies larger than 8 MiB never replace a usable saved response. If optional content cannot be saved, the recording remains available and Downloads lists which study content is saved.

Rebbe portraits, including additional speakers, live in `yutorah-portraits-v1`, shared across recordings and thumbnail URL variants. The downloader tries the same 240×280 original and thumbnail fallback as the UI, saves one readable image of at most 512 KiB, and fetches directly from the CDN with CORS. No image relay adds website-hosting bandwidth, and opaque responses are rejected. Cache hits avoid another image download. The UI can read the saved portrait without an active service worker. Original URLs remain in library metadata.

Downloads offers **Read transcript & notes**. The study reader uses saved content offline, including notes when there is no transcript. Transcript timestamps still seek the saved recording. External source sheets and linked source texts are not downloaded. PDF/Word exporters and the hosted complete-text link appear online; reading, expanding notes and saving a transcript as text work offline. Missing content explains that a connection is needed.

Downloaded recordings save available images and study content automatically. Existing audio-only downloads gain these materials when opened online. The app silently checks for missing or revised study content at most hourly on library refresh, return to the app, reconnection, and while the app remains visible. There is no manual update action or success notification. Online reader responses also refresh saved content for downloaded recordings. Network failures preserve the saved copy. Removing a download deletes its study content; shared portraits remain while another download uses them. Startup reclaims unreferenced content and images after a 15-minute grace period that protects writes in another tab. Audio byte counts exclude these small supporting assets.
