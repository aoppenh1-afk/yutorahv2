# YU Torah design direction

Research date: September 8, 2026.

Recommendation: a modern editorial listening library. Use Apple Music's hierarchy and mix of content sizes, Spotify's persistent listening model, and the subject clarity of Torah libraries. Keep YU blue, give teachers and series more visual presence, and make the next learning action easy to find.

This is a design research brief, not an implemented redesign. The companion concept uses illustrative collection names. The existing app has not been changed.

## What I reviewed

I visually inspected the public desktop pages of Apple Music, Spotify, TorahAnytime, OU Torah, Sefaria, and ARTE, plus this project's local homepage and teacher directory. I also read the public YUTorah homepage and category results, Spotify's player documentation, and Pocket Casts' product page. Public logged-out pages can differ from signed-in experiences. These observations concern the pages inspected, not complete product or accessibility audits. Mobile recommendations below are proposed adaptations, not findings from mobile testing.

| Reference | Observed design pattern | Application to YU Torah | What to avoid copying |
| --- | --- | --- | --- |
| [Apple Music](https://music.apple.com/us/new) | Large editorial tiles above compact song rows and artwork shelves; a quiet sidebar; clear section headings. The inspected page rendered dark. | Give seasonal collections a deliberate visual identity. Alternate prominent collections with compact shiur lists. Use restrained chrome around the content. | Truncating long shiur titles as aggressively as song titles; promotional subscription banners. A light default is our recommendation, not a claim about the inspected Apple page. |
| [Spotify](https://open.spotify.com/) | Prominent global search, a persistent library area, square content artwork, and circular artist portraits. | Keep search available throughout navigation. Give series consistent covers and teachers recognizable portraits. Distinguish personal learning from discovery. | Copying its green brand, oversized empty-library prompts, or making every learning action dependent on signing in. |
| [Spotify's Now Playing documentation](https://support.spotify.com/us/article/now-playing/) | A queue and an expanded Now Playing view; mobile playback sits above navigation. | Preserve the existing continuous player. Put the queue, source material, and notes within reach of the active shiur. | Music-specific controls taking priority over speech controls. For shiurim, speed and skipping back are more useful than shuffle. |
| [TorahAnytime](https://www.torahanytime.com/) | Video thumbnails, named speakers, visible durations, topical shelves, and separate Recent, Trending, and Following destinations. | Identify speaker, subject, duration, and format before a click. Provide topical entry points and a clear path back to previous learning. | Multiple competing banners and inconsistent promotional artwork. The initial visit also showed an account modal before browsing. |
| [OU Torah](https://outorah.org/) | Topic tiles, featured authors, branded series artwork, seasonal material, and media indicators. | Treat series as recognizable bodies of learning. Keep Gemara, Halacha, Parsha, and other subject paths easy to find. | The inspected desktop layout divides the page among several adjacent navigation/content columns, leaving less room for individual titles. |
| [Sefaria](https://www.sefaria.org/texts) | Serif category titles, short explanations, whitespace, and restrained subject colors. | Preserve textual dignity and clear taxonomy. Use an editorial serif selectively and give Hebrew proper room and direction. | Making the listening homepage resemble a text index. Browsing shiurim needs speaker and playback context. |
| [ARTE](https://www.arte.tv/en/) | An image-led lead feature, short synopsis, duration, and a clear Watch action. | Give an important seasonal collection one strong lead feature with a short explanation and clear action. | A viewport-filling hero or autoplay. Returning listeners should reach their learning quickly. |
| [Original YUTorah](https://cf.yutorah.org/) and its [category results](https://yutorah.org/categories/halacha/jewish-law/family--ishut/) | Seasonal collections, daily learning, detailed subject taxonomy, and filters for format, language, and duration. | Preserve these domain-specific routes into the library. Design must work with real titles, dates, formats, and source availability. | Showing the full taxonomy on every page. Reveal detailed filters where people need them. |
| [Pocket Casts](https://pocketcasts.com/) | The public product page emphasizes listening, discovery, and curated recommendations. | Use spoken-audio products as a further reference when refining listening controls and series discovery. | Treating a marketing page as proof of the signed-in web player's exact behavior. I did not inspect that player. |

## Why the current site feels basic

The current homepage already has a coherent blue palette, an editorial heading, a sidebar, daily learning, and a seasonal feature. Its functionality is substantially more developed than its visual presentation suggests.

On the inspected 1280 × 720 desktop viewport, the greeting, search area, and daily-learning strip occupy most of the area above the seasonal feature. The greeting is stronger visually than the shiurim. A returning listener gets a lot of introduction before content.

The teacher directory puts small portraits inside large, nearly identical bordered cards. The empty space around each portrait is more prominent than the teacher. Many pale borders and muted labels flatten the hierarchy. The repeated invitation to explore adds little once the entire tile already communicates that action.

The current ShiurCard component puts a number or YUTORAH label, category, title, small teacher avatar, duration, save, and play into the same card template. That is useful metadata, but it cannot provide all the visual variety needed for featured collections, individual recordings, and dense search results.

Source inspection was bounded to the entry point, card component, relevant homepage markup, stylesheet, and README. Graph generation was 2026-09-08T01:27:43Z. Reported parse gaps in app/torah-app.tsx at line 905 and app/globals.css at line 5 were read directly. This is not an exhaustive architecture assessment.

## Recommended visual system

Use a light default with an optional dark listening theme. The light version should feel crisp, with a slightly warm page background, white content surfaces, dark ink text, and deep blue for navigation and primary actions. Dark mode should be a complete palette with readable secondary text, not a color inversion.

Proposed starting colors, subject to contrast checks during implementation:

| Role | Starting value |
| --- | --- |
| Page | #F7F8FA |
| Surface | #FFFFFF |
| Primary text | #18263B |
| Secondary text | #536174 |
| Brand/action | #173F82 |
| Selected background | #EAF0F9 |
| Divider | #E2E7EF |
| Occasional editorial accent | #A7834D |

Gold should be scarce and decorative. Essential text and actions should not depend on low-contrast gold.

Use a clean sans serif for navigation, controls, metadata, and most titles. Keep a serif for the main editorial feature and occasional major headings. Start with the project's existing fonts; compare alternatives in context before adding a dependency. Use a compatible Hebrew fallback and automatic text direction for mixed-language titles. Avoid letter-spacing Hebrew text.

At desktop sizes, aim for a 220–240 px sidebar, a compact 64–72 px header, 32–40 px content margins, 24 px section headings, and 15–16 px content text. Use an 8 px spacing rhythm. Cards need roughly 10–14 px corner radii, with light shadows only where elevation communicates a state. These are design starting points, not measurements of reference sites.

### Content needs different presentations

- Featured collection: wide cover, editorial title, one short description, one primary action.
- Series: consistent square or slightly landscape artwork; title and teacher outside the artwork remain real text.
- Teacher: a larger clean portrait with the name directly underneath; minimal surrounding box treatment.
- Individual shiur: compact row with play, title, teacher, duration, and save. Allow titles to wrap.
- Search result: a readable list with relevant metadata and excerpts. Filters stay visible or one clear action away.
- Daily learning: a compact band that remains easy to scan.

Create a small family of series-cover templates using typography, subject, and a restrained palette. Reuse one cover throughout a series. Use authentic teacher photographs at their useful resolution; do not enlarge tiny images into banners. When assets are poor or absent, use a well-designed typographic cover or initials fallback. Do not invent teacher portraits or attach an unrelated image to a shiur.

## Homepage composition

1. A compact header with the YU Torah identity and persistent search.
2. Continue learning, when actual history exists. Show the recording title and remaining time. Omit the section for first-time visitors.
3. One seasonal editorial feature, around 280–340 px tall on a wide desktop. Use clear language such as Prepare for Rosh Hashana, with a short supporting line.
4. This week's learning, using a small set of curated collection covers.
5. Teachers, with recognizable portraits and clear names.
6. Recently added shiurim, in compact rows with visible duration and format.
7. Detailed topic discovery farther down, with direct navigation also available in the sidebar.

Keep the player anchored while a recording is active. Put the title and teacher at the left, play and seek controls in the center, and speed, queue, and source access on the right. On mobile, use a mini-player above a short bottom navigation bar and expand controls on tap. Do not reserve a large blank player before a selection exists.

On mobile, reduce the hero, stack content deliberately, and keep a visible route to full lists. Avoid making horizontal swiping the only way to find important content. Touch targets should be comfortable, focus should remain visible, and controls must work without hover. Respect reduced-motion settings.

## Boundaries that matter

The app already supports search, playback continuity, local saved items, playlists, notes, and history according to its README. Improve their presentation without accidentally removing them. Do not introduce Following, cross-device sync, or personalized recommendations as if those services already exist. Keep the device-local storage disclosure accessible near personal learning features, with less prominence in global chrome.

Display source sheets or video actions only when supplied. Do not invent transcripts, chapter markers, popularity counts, or recommendation reasons to fill a design. Hebrew dates and seasonal copy should use actual data rather than a permanently hard-coded holiday.

Keep the current independent-interface disclosure available and retain donor attribution in a considered location. Any official branding changes would need verified brand assets.

## Suggested implementation order

1. Establish typography, contrast, spacing, navigation, and the compact header.
2. Redesign the homepage with distinct collection, teacher, and shiur presentations.
3. Apply the same system to teacher and series pages, followed by search results.
4. Refine the player, mobile navigation, loading, empty, and error states.

Before release, check long English and Hebrew titles, missing and low-resolution portraits, first-time and returning visitors, audio/video/text records, keyboard use, small screens, and playback across navigation. Test real content before polishing a mock dataset. The first desktop screen should expose a meaningful content action and establish the library's identity without excessive introductory copy.

My preferred direction is the light editorial version. A dark streaming version is a useful optional theme, but the main improvement will come from content hierarchy, better artwork, and a more deliberate mix of layouts.
