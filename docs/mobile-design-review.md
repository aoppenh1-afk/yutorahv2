# Independent YUTorah institutional design review

Review started against the first institutional revision, then repeated in fresh sessions after the mobile search/palette/logo cleanup and after the final desktop/editorial batch.

## Final assessment: 9.2/10

Yes: the current mobile site looks professionally designed for YUTorah. The final desktop batch also now reads as the same institution. The genuine featured teacher and shiur title, consistent navy/white palette, official wordmark, editorial headings, and quiet underline navigation are materially more convincing than the rejected app-like treatment. Real records and visible collection counts make the archive's scale believable.

| Area | Score /10 | Assessment |
|---|---:|---|
| Institutional visual identity | 9.3 | Official branding, clear YU affiliation, restrained presentation of real teaching |
| Typography and composition | 9.3 | Strong serif hierarchy, readable metadata, controlled spacing; full desktop recording titles |
| Mobile hierarchy and content density | 9.0 | Useful landing paths and readable record rows; secondary tools stay accessible through disclosures |
| Cross-view consistency | 9.2 | Desktop and mobile now share an editorial library language |
| Usability | 9.2 | Clear navigation, native mobile record actions, persistent saved state, verified player controls |

The desktop recommendation shelf was the last actionable criticism at the preceding 9.1/10 review: large generated topic covers repeated categories and displaced genuine titles, including truncating “Understanding the Connection Between Shemini Atzeret and Simchat Torah.” The final card revision resolves it. Fresh 768/1024/1440 contexts show a compact genuine portrait/name/category row and the full editorial title, with no duplicate cover or badge. The cited title has no line clamp, and its scroll/client dimensions match at every width. Play/Save controls are 44 pixels high; Save toggles to Unsave, and Play/Pause updates actual audio state using the disclosed fixture. Evidence: `review-final-recordings-768.png`, `review-final-recordings-1024.png`, `review-final-recordings-1440.png`.

No remaining actionable design or implementation defect was found in the reviewed scope. This is a professional institutional interface, with the usual room for later product development; the score is not a claim that every archive task or physical device has been tested.

All ten earlier actionable issues listed below, plus the subsequent recommendation-card criticism, are resolved by the inspected final implementation. The results hint is hidden when results exist; the first genuine search record moved from y=463 to y=415 at 390 pixels. Mobile row play is now `rgb(50, 90, 137)`. Following's empty state has no duration toolbar; Notes is a subordinate “Study notes” section; short placeholders fit at 320 pixels. The official desktop wordmark, navy editorial feature, neutral subject cards, and underline tabs now provide continuity. Featured-series counts use the directory value for a matching ID, with the genuine home value as a fallback.

## Benchmark and initial assessment

The benchmark is a credible public university Torah archive with hundreds of thousands of recordings: institutional identity, clear editorial typography, usable discovery density, continuity across views, and reliable controls. A passing button test is not a passing design review.

The current mobile home is a substantial improvement over `/tmp/yutorah-mobile-v3/home-390.png`. Its official wordmark, restrained navy, serif headings, genuine teacher portraits, and real library/teacher counts make it read as YUTorah. The first institutional review was provisionally 8.7/10 for the complete experience, about 8.9/10 for mobile alone. The score was held below 9 by the remaining desktop visual mismatch and secondary-view hierarchy, not by rejection of the redesigned mobile home.

## Criticism record, before final batch

1. Search originally retained a heavy sans-serif “What will you learn next?” title, electric-blue links, multiple open secondary controls, and a duplicate empty-state prompt. The first cleanup fixed this with a serif “Search the library,” a single tools disclosure, and working topic/teacher/series browse paths. Verified in fresh 320/390/430 sessions.
2. The empty-library CTA used saturated electric blue unlike the archive home. The first cleanup changed it to subdued navy. Verified in `/tmp/yutorah-institutional/review-library-390.png`.
3. Desktop originally used an invented “YU Torah / TORAH. EVERY DAY.” mark. The first cleanup replaced it with the original institutional wordmark. Verified at 1440 pixels.
4. Desktop still retained a saturated indigo sidebar/search arrow, rounded pill tabs, multicolored decorative collection and series cards, heavy sans headings, and a promotional Jerusalem-landscape hero. These felt like a different product from the navy/white editorial mobile archive. Layouts need not match, but palette, typography, and presentation of teaching should.
5. Result pages retained a two-line typing hint and generous top spacing after results loaded. A real search placed the first recording at y=463 at 390 pixels, reducing the visible catalog to roughly two records with the miniplayer open. Hide the typing hint once results exist and tighten result-only spacing.
6. Search and saved-library placeholders visibly clipped at both 320 and 390 pixels. Shorter placeholders would fit the screen and be clearer.
7. `.mobile-row-play` retained hard-coded indigo `#3c5cd4` against `#edf2fc` despite the first palette cleanup. The real search screenshot confirmed the mismatch.
8. Empty Following showed duration filters before any teacher/topic/series had been followed. Hide controls with no useful effect in that state. Its active “Any length” chip also retained indigo styling.
9. Notes added an almost equally large “Your notebook” title immediately under “Your library.” It should be a subordinate section heading, consistent with the other library tabs.
10. Genuine upstream counts disagreed for Ten Minute Mussar, ID 4334: `/api/home` returned 1,052 and `/api/directory` returned 1,014. The interface showed different counts for the same series. Use one authoritative display count across those views; do not invent a replacement count.

## Independent verification completed

- Fresh browser contexts at 320×844, 390×844, 430×844, and 1440×900. Home, topics, teachers, series, search landing, and empty library checked. Fresh home hydration was awaited using `.archive-teachers`, rather than assuming visible SSR buttons were interactive. These fresh mobile loads took approximately 2–3 seconds in the reviewed environment.
- No horizontal overflow and no JavaScript page errors in those contexts. Directories render real teacher portraits and genuine large recording counts.
- Actual narrow live search for “Bringing Hashem Back Down” completed with 39 results. Portraits loaded after their initial reserved boxes. This was separately inspected from the controlled search fixture.
- Saving a genuine featured shiur persisted through reload; it appeared in Your library. The labeled recording action sheet opened and Mark as learned updated the record.
- Mobile miniplayer and full-screen player inspected at all three widths. The full player filled the viewport without horizontal overflow.
- Playback, pause, 1.5× speed, and ±15-second seek verified using a local 120-second WAV substituted only for audio transport. Proper HTTP 206 Range handling produced currentTime 0.13 → 15.33 → 0.61 seconds. The final repeat also passed at all three mobile widths, with forward positions 15.62/15.27/15.19 seconds. This proves transport behavior, not reliability of upstream YUTorah streaming.
- 320×568 player checked separately: 568-pixel viewport, 644-pixel scrollable content, all controls reachable by scrolling. No short-height player defect found.
- Controlled search fixtures reused real home-recording data for repeatable layout checks at 320/390/430; they were not used to claim actual search completeness or relevancy.
- Desktop recommendation and teacher shelves were scrolled into view before judging their images. All six visible teacher shelf portraits loaded at native width 240 pixels. Empty circles in the initial full-page capture were lazy-loading placeholders, not missing-image defects.
- The final desktop recording-card revision was independently scrolled and inspected in fresh contexts at 768×900, 1024×900, and 1440×900. All recording titles were fully visible with no horizontal overflow, all contexts had zero page errors, Save updated its label to Unsave, and Play/Pause worked at all three widths. Primary controls measured at least 44 pixels high and wide.
- T3 preview workflow attempted first: preview_status, then preview_open. An open briefly reported availability, but resize timed out and snapshot reported no host. Shell Playwright with `/usr/bin/google-chrome` was therefore used for the independent evidence.

## Evidence

- Rejected prior design: `/tmp/yutorah-mobile-v3/home-390.png`.
- Mobile home: `review-home-320.png`, `review-home-390.png`, `review-home-430.png` and matching `review-home-full-*.png` in `/tmp/yutorah-institutional/`.
- Search landing: `review-search-320.png`, `review-search-390.png`, `review-search-430.png`.
- Genuine search: `review-live-search-390.png`; `independent-live-search-results.json` records first-row position and loaded portraits.
- Controlled result layout: `review-search-results-fixture-320.png`, `review-search-results-fixture-390.png`, `review-search-results-fixture-430.png`.
- Directories: `review-topics-*.png`, `review-teachers-*.png`, `review-series-*.png`.
- Library: `review-library-*.png`, `review-library-saved-*.png`, `review-history-390.png`, `review-playlists-390.png`, `review-notes-390.png`.
- Following: `review-following-empty-390.png`.
- Player: `review-miniplayer-*.png`, `review-player-*.png`, `review-player-short-320.png`, `review-player-short-bottom-320.png`.
- Desktop: `review-home-1440.png`, `review-home-full-1440.png`, `review-home-loaded-full-1440.png`, `review-desktop-recordings-1440.png`, `review-desktop-teachers-1440.png`.
- Final desktop cards: `review-final-recordings-768.png`, `review-final-recordings-1024.png`, `review-final-recordings-1440.png`. These supersede the earlier recommendation-card appearance in the full-page desktop evidence.
- Machine-readable results: `independent-capture-results.json`, `independent-journey-results.json`, `independent-transport-results.json`, `independent-additional-results.json`, `independent-persistence-results.json`, `independent-final-cards-results.json`.

Physical-phone browser behavior, background playback, and reliable upstream audio delivery were not established by these desktop-browser checks. The local fixture is disclosed above; no production audio guarantee is inferred from it.
