# YUTorah redesign

September 30, 2026

The redesign makes listening, returning to an unfinished recording, and choosing the next shiur the main actions. A white sidebar, cobalt navigation, a pale canvas, larger sans-serif headings, and a Jerusalem image set the visual direction. Mint, coral, blue, and lilac collection covers help people browse. Teacher portraits retain their original colors and live metadata supplies the titles and counts.

The visual update removes the shared grayscale filters, enlarges portraits, and adds teacher names and labeled play controls to recording cards. The hero has direct listening and topic browsing actions. The teacher directory, daily learning links, progress cards, and floating player share the same typography and spacing. Mobile covers prioritize the portrait; the player expands to expose seeking, playback speed, volume, notes, and queue controls.

## Research and decisions

| Reference                                                                                                                                                   | Useful pattern                                                                              | Implementation                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Spotify: Your Library](https://support.spotify.com/uk/article/your-library/) and [web player](https://open.spotify.com/)                                   | Persistent access to saved content, follows, library search, and filters.                   | Separate Explore and Your Learning navigation, bookmark controls on recordings, teacher/topic/series follows, and duration chips.                                                                         |
| [Apple Music editorial browsing](https://music.apple.com/us/new) and [queue documentation](https://support.apple.com/en-lamr/guide/iphone/ipha4521ef7d/ios) | Editorial shelves, a compact MiniPlayer, and an expanded view for playback and the queue.   | Large editorial feature, typographic collections, teacher and series shelves, a persistent desktop player, and expandable phone controls.                                                                 |
| [TorahAnytime](https://www.torahanytime.com/) and its [publisher's app description](https://apps.apple.com/us/app/torahanytime/id1520450234)                | Discovery through speakers, topics, and series; following those interests.                  | Authentic teacher profiles, follow buttons, a Following feed, and explained recommendations. The website requires JavaScript, so the publisher's app description supplied the verifiable feature details. |
| [OU Torah's series sampler](https://outorah.org/series/4149/) and [Nach Yomi](https://outorah.org/p/4032)                                                   | Daily learning and recognizable series help people choose content that fits their schedule. | Ten Minute Halacha, parsha, Daf Yomi, and Jewish thought collections; live daily daf, mishna, and Nach links.                                                                                             |

These are design references. This app does not connect to their accounts or imply affiliation with them.

## Behavior and data

- **Continue learning:** unfinished recordings appear before the editorial feature, with a progress bar, remaining time, and an explicit resume action. Playback history is written when a recording starts and during listening, pause, seek, and page exit. Seeking to zero persists, and replaying an almost-finished recording starts it again.
- **History and library:** recordings retain separate playback positions. Saved shiurim, playlists, timestamped notes, follows, goals, and preferences remain in browser storage. Reloading restores the last recording without autoplaying it.
- **Trending:** `/api/discover` requests six public search pages, up to 180 recent recordings, then ranks unique records by `shiurvisitsnum`. Downloads break view ties. These are lifetime counts across that sample. Absent counts are never replaced with invented values. Partial results and upstream failures are disclosed.
- **Related learning:** `/api/related` fetches the source and up to four additional first-page searches: its series, two topics, and teacher. Topic IDs from the sparse detail response are preserved. Specific series rank first, followed by topic and teacher matches; short recordings receive a preference when the source is short. Generic series such as “Daily Shiur” do not outweigh topic relevance. Current, hidden, and completed recordings are excluded. Each result explains its match.
- **Daily learning:** labels come from YUTorah's homepage data. Missing parsha data falls back to general parsha browsing. Ten Minute Halacha resolves to the actual directory series, ID 4233, rather than an invented collection of recordings.
- **Playback:** navigation retains the audio element. Seeking, speed, volume, queue, sleep timer, notes, and timestamp sharing remain available. Mobile controls expand to reveal seeking, speed, notes, and the queue.
- **Failure states:** discovery, follows, and related learning expose loading, retry, partial-data, and empty states. Portrait failures fall back to initials. The initial recommendation ranking uses a shared reference time for server/client consistency.

The app uses public YUTorah metadata and media. Trending is a bounded recent-upload chart, and recommendation candidates are bounded first-page results. Personal data is local to this browser; account synchronization and offline downloads are not implemented. Existing transcript search still depends on the separately deployed transcription service.

## Generated image

Asset: [`public/images/jerusalem-editorial.jpg`](../public/images/jerusalem-editorial.jpg). Generated with ImageGen, inspected, then exported as a compressed JPEG. It is general editorial scenery; it does not depict a teacher or purport to illustrate a particular recording. Teacher portraits are supplied by YUTorah.

Prompt:

> Use case: photorealistic-natural. Asset type: cinematic editorial background for a premium Torah audio library website, landscape 1536x1024. Primary request: authentic quiet Jerusalem at golden hour, a view through an old Jerusalem limestone arch on the right, ancient pale stone rooftops and softly distant rolling Judean hills, olive tree branches, soft amber sunlight falling on richly textured cream limestone. Composition: wide view, arch and architectural detail on right two thirds, left third mostly shadowed deep navy and calm negative space because the website will overlay a white title there. Photo style: high-end travel magazine, natural realistic fine textures, filmic subtle grain, tactile shadows, muted honey gold, sage, warm sandstone and deep midnight blue. Atmosphere: contemplative, dignified, quietly beautiful. No people. No text, lettering, logos, watermarks, UI, religious symbols or invented landmarks. Avoid oversaturated orange, fantasy architecture, garish lens flare. This is general editorial scenery, not a picture of a specific teacher or shiur. Save the generated image to disk.

See [QA.md](../QA.md) for the checks performed on this revision.
