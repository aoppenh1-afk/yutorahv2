# Mobile Torah library

The mobile redesign treats YUTorah as a substantial public Torah archive. The phone composition is dedicated below 768 CSS pixels; the wider composition now shares its visual identity.

The user rejected the earlier music-app-inspired home despite favorable reviews. Those earlier scores did not establish that the design met the institutional brief. This revision replaces that direction and was reviewed against university-library quality.

## Design and research

- The original [YUTorah wordmark](https://cdnyutorah.cachefly.net/public/v3/images/logos.png) supplies the phone header and desktop sidebar. The original [RIETS shield](https://cdnyutorah.cachefly.net/public/v3/images/logo-university.png) supplies the favicon. Both are served locally without modifying their proportions or lettering.
- [Yeshiva University's branding guidance](https://www.yu.edu/marketing/branding) and its linked [identity guide](https://www.yu.edu/sites/default/files/inline-files/_FINAL_YU_Branding_Guide3%202017_0.pdf) informed the dominant Yeshiva Blue accent, #325A89. Navy, white, gray, editorial serif headings, and simple ruled sections replace the indigo/pastel system.
- The [Library of Congress](https://www.loc.gov/) informed the priority given to library search, collection access, and editorial discovery for a large archive.
- Earlier interaction research remains useful: [Apple Music's compact and expanded player](https://support.apple.com/en-gb/guide/iphone/iph676daac9b/ios), [Spotify's library and queue organization](https://newsroom.spotify.com/2026-05-28/playlist-folders-mobile-queue-controls-updates/), published [TorahAnytime screenshots](https://apps.apple.com/us/app/torahanytime/id1520450234), [AllDaf screenshots](https://apps.apple.com/us/app/all-daf/id1480151101), and [TorahApp screenshots](https://apps.apple.com/us/app/torahapp/id6470222031). Their interaction patterns informed navigation, persistence, daily learning, and listening controls. They do not determine the archive's visual identity.
- Genuine teacher portraits replace decorative lesson covers. The image component prefers the larger originals used on YUTorah's [teacher pages](https://www.yutorah.org/teachers/Rabbi-Eli-Wagner), falls back to the supplied thumbnail, and then uses initials if both fail.

## Composition and behavior

The first phone screen presents the original institutional wordmark, a clear Torah-library heading, prominent search, live archive and teacher totals, a featured shiur with its genuine teacher portrait, and the beginning of the recording list. There are no invented album illustrations or assumed weekly-parsha labels.

Recently added uses the live home recent feed, with a date-sorted fallback. Recommended uses the existing discovery and learning model. Under 20 min filters genuine durations and offers a full-library filtered search. Resume, saved shiurim, daily learning, subjects, teachers, and series use existing data and actions. The directory's count is the authoritative displayed count for a featured series also shown on Home; the genuine home count remains the fallback while the directory is unavailable.

Five labeled destinations remain visible: Home, Search, Browse, Following, and Library. Browse has Topics / Teachers / Series tabs; Library has Saved / History / Playlists / Notes. Empty Following presents a useful follow action without duration filters. Notes uses a subordinate Study notes heading under Your library.

Search has a serif heading, short placeholders, one secondary-tools disclosure, and three working browse paths on its landing page. After submission, the typing hint is hidden and secondary controls remain expandable. A compact disclosure shows actual match counts and Updating / Paused / Complete state without claiming a provisional count is final.

The recording action sheet retains details and notes, saving, queueing, playlist membership, and learned-state actions. Short notifications expire after four seconds and are hidden while modal dialogs or sheets are open.

The compact player sits above bottom navigation and expands into a full-screen player with the teacher's genuine photograph. Playback position, skips, pause, speed, volume, notes, queue, and next item retain the existing audio model. Short screens scroll so controls remain reachable. Local history, saved records, playlists, and notes retain their existing browser storage.

The wide home now presents the actual featured lecture and teacher in a navy editorial feature. It shares the wordmark, serif hierarchy, navy accents, underline tabs, and restrained subject/card treatments with mobile. Recording cards show compact genuine teacher portraits and full lecture titles without decorative covers or title clamping.

## Implementation

- [Mobile home](../app/mobile-discover.tsx): phone composition, live source selections, browse paths, and existing action callbacks.
- [Mobile styles](../app/mobile.css): phone hierarchy, navigation, search, directories, rows, dialogs, and player.
- [Shared UI](../app/ui.tsx): original portrait fallback, readable mobile recording cards, action sheets, and mobile playback.
- [Application](../app/torah-app.tsx): native view tabs, search layout, modal integration, and institutional wordmark.
- [Wide home](../app/learning-home.tsx) and [shared styles](../app/redesign.css): consistent desktop feature and archive identity.
- [Notebook](../app/notebook.tsx): appropriate heading hierarchy inside the phone Library tab.

## Verification

TypeScript, oxlint, all 24 existing learning/discovery tests, and the production build pass. The build retains its existing large-client-chunk advisory.

Browser evidence is in /tmp/yutorah-institutional/. The 19 journeys check home selections, directory tabs, saving/retrieval, action sheets, learned state, actual audio transport controls, queue, library tabs, notes/details, preferences, submitted search, and reflow at 320, 360, 390, 430, 600, 767, 768, 1024, and 1440 pixels. Focused follow-up journeys verify home-form submission, collapsed search tools, browse paths, the empty library, and full desktop titles with working Play/Save controls at 768, 1024, and 1440 pixels.

Live home, directory, and narrow metadata-search responses were used. A local 120-second WAV substitutes only for audio transport and handles HTTP 206 Range requests correctly. Successful player checks establish control behavior; they do not establish reliability of the upstream audio service or native-phone background playback.

## Independent review

A fresh reviewer initially graded the institutional revision provisionally 8.7/10, finding desktop visual mismatch and secondary-view problems. The reported issues were addressed: search hierarchy and palette, short placeholders, result density, Following controls, Notes hierarchy, desktop continuity, and inconsistent upstream series counts.

The [final independent review](mobile-design-review.md) gives the completed revision **9.2/10**, with no remaining actionable design or implementation defects found in the reviewed scope. The preceding 9.1/10 review identified one remaining desktop-card issue: decorative covers displaced and truncated actual lecture titles. Compact teacher details and full editorial titles resolved that criticism; the reviewer independently verified the final cards, saving, and playback at 768, 1024, and 1440 pixels. The report preserves earlier criticisms, evidence, and verification limits.
