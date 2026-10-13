# YUTorah feature parity audit

Audited October 13, 2026. Compared the current public yutorah.org website using the Codex Chrome extension with https://yutorah.vercel.app and this repository's current working tree, including existing uncommitted changes.

## Findings

The main gaps are official collections, publications and volumes, venues, a dedicated Daf workspace, and chapter-based study tools. Basic search, listening, saving and private account sync are already implemented.

There are **27 findings: 13 missing capabilities, 12 partial implementations, one intentional account boundary, and one copy defect**. Eight are P1. These are grouped product findings, not a count of every button or every missing page.

P1 means a core learning/navigation gap or loss of search restrictions or attribution. P2 means useful parity work after the core entities are supported. P3 means lower-priority parity or a product-scope decision. These priorities are recommendations.

## Coverage and limits

I inspected the homepage and its main navigation menus, Daf Yomi, a teacher profile and its Collections tab, a series page, a topic page, venue-filtered search, publication search with volume facets, an official collection page, a modern audio/transcript page and its Summaries/Reflections tabs, a PDF article page, the contact form, and the Balk Legacy resource page. I also inspected our deployed homepage, shiur/transcript detail and legacy-search redirect.

This covers the main publicly discoverable page types and representative workflows. It is not a crawl of every recording or every historical/special-purpose page. The original homepage reported 444,121 shiurim during inspection. Original-site authenticated posting, account-library management, email delivery, subscriptions, donation checkout, and bulk download were not exercised. Original-site Ask speaker returned a login requirement. Our cross-device sync and notification delivery were inspected in source, not retested with multiple accounts/devices.

The web fetch tool returned HTTP 403 for the original homepage; Chrome loaded the site. Several original pages initially showed loading placeholders, so loaded states were read before conclusions. Our deployed homepage initially showed an unavailable state and later recovered without intervention; that transient observation is not classified as a confirmed production defect.

No forms were submitted, messages sent, subscriptions created, or application code changed. Navigating the original Daf page started playback; it was paused during inspection. Existing working-tree changes were left intact.

## Recommended build order

1. Fix legacy-search parameter preservation and stale storage/sync copy. These are bounded defects and do not require a new product area.
2. Preserve venue and all-speaker/author metadata; add official collections with their ordered memberships. A YUTorah collection is distinct from an upstream series and from a personal playlist.
3. Add collection navigation, teacher/entity landing pages, publication/volume browsing and venue search. Update legacy path handling alongside the new entities.
4. Add upload-date search and accurate contextual facets. Then add a Daf workspace with exact page/side selection.
5. Extend the existing official transcript adapter with chapter navigation, official summaries and quizzes where upstream content exists. Reuse supplied content before proposing another generation service.
6. Add podcast/RSS links, article reading/print, selective batch actions and email subscriptions according to demand. Link to original resources for the lower-priority institutional and account-bound features.

## Detailed checklist

| ID | Priority | State | Feature |
| --- | --- | --- | --- |
| [G01](#g01) | P1 | Missing | Official collections |
| [G02](#g02) | P1 | Missing | Publications and volumes |
| [G03](#g03) | P1 | Missing | Venues |
| [G04](#g04) | P1 | Partial | Original URL compatibility |
| [G05](#g05) | P1 | Partial | Upload date versus lecture date |
| [G06](#g06) | P1 | Missing | Daf study workspace |
| [G07](#g07) | P1 | Missing | Chapter navigation |
| [G08](#g08) | P2 | Partial | Official summaries |
| [G09](#g09) | P2 | Missing | Reflections and quizzes |
| [G10](#g10) | P2 | Partial | Teacher, series and topic landing pages |
| [G11](#g11) | P2 | Missing | Contextual facet counts |
| [G12](#g12) | P2 | Missing | RSS and podcast subscriptions |
| [G13](#g13) | P2 | Partial | Email subscription channel |
| [G14](#g14) | P2 | Partial | Article PDF viewer and print |
| [G15](#g15) | P1 | Partial | All speakers and authors |
| [G16](#g16) | P2 | Partial | Category hierarchy and attribution |
| [G17](#g17) | P2 | Partial | Select specific results for batch actions |
| [G18](#g18) | P3 | Partial | Multiple formats and other languages |
| [G19](#g19) | P3 | Missing | Public comments |
| [G20](#g20) | P3 | Missing | Ask speaker or author |
| [G21](#g21) | P3 | Boundary | Original YUTorah accounts and library import |
| [G22](#g22) | P2 | Partial | Editorial campaigns and featured collections |
| [G23](#g23) | P3 | Missing | Special resource landing pages |
| [G24](#g24) | P3 | Missing | Donation links and dedications |
| [G25](#g25) | P2 | Partial | Feedback and contextual error reporting |
| [G26](#g26) | P3 | Missing | Terms and expanded attribution links |
| [G27](#g27) | P2 | Copy defect | Storage and sync explanations |

### G01

**Official collections** · P1 · Missing · Library

Original-site evidence: Numbered course collections, counts, latest update, oldest/newest order, subscription, and related collections. [Open inspected page](https://www.yutorah.org/collection/15353).

Current project: We have series and personal playlists, but no upstream collection entity, membership, order, or collection pages.

Suggested completion: Add collections as a separate library entity. A learner should open collection 15353 and navigate its 13 lessons in order.

Code evidence: [lib/yutorah.ts:20](../lib/yutorah.ts#L20), [lib/yutorah.ts:372](../lib/yutorah.ts#L372), [app/secondary-screens.tsx:249](../app/secondary-screens.tsx#L249).

Verification: Verified public UI and/or current source.

### G02

**Publications and volumes** · P1 · Missing · Library

Original-site evidence: Publication directory grouped by English, Hebrew, pamphlets and parsha sheets; publication and volume filters. [Open inspected page](https://www.yutorah.org/publications?publicationid=247).

Current project: Articles are searchable by format, but publications and volumes are absent from the directory and filters.

Suggested completion: Add publication browsing and volume filters. Preserve article author, publication and issue information.

Code evidence: [lib/yutorah.ts:372](../lib/yutorah.ts#L372), [lib/search-filters.ts:3](../lib/search-filters.ts#L3), [app/advanced-search.tsx:149](../app/advanced-search.tsx#L149).

Verification: Verified public UI and/or current source.

### G03

**Venues** · P1 · Missing · Library

Original-site evidence: Venue navigation and venue-filtered search. YU Wilf Campus resolves to location=439. [Open inspected page](https://www.yutorah.org/search/?location=439).

Current project: The adapter drops venue metadata; no venue directory or filter exists.

Suggested completion: Keep venue IDs and names on each shiur, add venue browsing, and support compound searches within a venue.

Code evidence: [lib/api-types.ts:44](../lib/api-types.ts#L44), [lib/yutorah.ts:139](../lib/yutorah.ts#L139), [lib/search-filters.ts:3](../lib/search-filters.ts#L3).

Verification: Verified public UI and/or current source.

### G04

**Original URL compatibility** · P1 · Partial · Search

Original-site evidence: Links use s, teacher, category, series, collection, location, publication and date parameters, plus entity paths. [Open inspected page](https://www.yutorah.org/search/?series=4031).

Current project: Lecture and teacher redirects exist. LegacySearch keeps only q/search/query/term and discards the original filters. No collection, publication, venue, category, series or daf page routes exist.

Suggested completion: Translate supported upstream parameters and routes without silently dropping restrictions. Confirm /search/?series=4031 remains a Daf Yomi search.

Code evidence: [app/search/[[...slug]]/page.tsx:3](../app/search/[[...slug]]/page.tsx#L3), [app/teachers/[...slug]/page.tsx:3](../app/teachers/[...slug]/page.tsx#L3), [app/lectures/[...slug]/page.tsx:3](../app/lectures/[...slug]/page.tsx#L3).

Verification: Verified public UI and/or current source.

### G05

**Upload date versus lecture date** · P1 · Partial · Search

Original-site evidence: Separate Date uploaded and Date given filters, with quick periods and custom ranges. [Open inspected page](https://www.yutorah.org/search/?location=439).

Current project: We retain uploadedAt for trending, but general search dates filter s.date. New this week also uses that lecture-date filter.

Suggested completion: Add an explicit date basis and upload-date ranges. Old lectures uploaded this week must appear in an upload-date search.

Code evidence: [lib/complete-search.ts:585](../lib/complete-search.ts#L585), [lib/yutorah.ts:664](../lib/yutorah.ts#L664), [app/search-tools.tsx:52](../app/search-tools.tsx#L52).

Verification: Verified public UI and/or current source.

### G06

**Daf study workspace** · P1 · Missing · Study

Original-site evidence: Scanned daf, a/b sides with counts, tractate and page selectors, previous/next daf, speaker switcher, Sefaria link and related material. [Open inspected page](https://www.yutorah.org/daf).

Current project: Today's Daf, Mishna, Nach and parsha are present, but clicking them starts a keyword search.

Suggested completion: Add a dedicated daf workspace with exact tractate/page/side selection and associated recordings.

Code evidence: [app/learning-home.tsx:883](../app/learning-home.tsx#L883), [lib/yutorah.ts:336](../lib/yutorah.ts#L336).

Verification: Verified public UI and/or current source.

### G07

**Chapter navigation** · P1 · Missing · Study

Original-site evidence: Named timed chapters in the transcript and audio player. [Open inspected page](https://www.yutorah.org/lectures/details?shiurID=1191528).

Current project: Our official reader fetches transcript VTT only and renders paginated timestamped segments. No chapter map is consumed or shown.

Suggested completion: Load available upstream chapters and make each heading seek to its start. Keep transcript paging independent of chapter navigation.

Code evidence: [lib/official-transcript.ts:107](../lib/official-transcript.ts#L107), [app/transcript-reader.tsx:29](../app/transcript-reader.tsx#L29).

Verification: Verified public UI and/or current source.

### G08

**Official summaries** · P2 · Partial · Study

Original-site evidence: Short overall description plus a Summaries tab with summaries organized by chapter. [Open inspected page](https://www.yutorah.org/lectures/details?shiurID=1191528).

Current project: Descriptions and our generated study notes exist. Official structured summaries are not consumed by the reader.

Suggested completion: Show upstream summaries and chapter summaries where available, with their provenance. Keep existing study notes.

Code evidence: [lib/official-transcript.ts:154](../lib/official-transcript.ts#L154), [app/transcript-reader.tsx:66](../app/transcript-reader.tsx#L66).

Verification: Verified public UI and/or current source.

### G09

**Reflections and quizzes** · P2 · Missing · Study

Original-site evidence: Reflections tab with multiple-choice questions and Show Right Answers. [Open inspected page](https://www.yutorah.org/lectures/details?shiurID=1191528).

Current project: No quiz, answer, review-question, or reflection interface exists.

Suggested completion: Read available official Quiz content and display questions and answer reveal. This does not require a new question-generation pipeline.

Code evidence: [app/transcript-reader.tsx:66](../app/transcript-reader.tsx#L66), [docs/official-yutorah-api-research.md:24](../docs/official-yutorah-api-research.md#L24).

Verification: Verified public UI and/or current source.

### G10

**Teacher, series and topic landing pages** · P2 · Partial · Library

Original-site evidence: Teacher biography, recent and top lectures, scoped search, and tabs for series, venues, categories and collections. Series and topic pages have similar browsing tools. [Open inspected page](https://www.yutorah.org/teachers/Rabbi-Aryeh-Lebowitz).

Current project: Directory cards open filtered searches. Series descriptions are retained, but teacher biographies and dedicated landing pages are absent.

Suggested completion: Add teacher profiles and entity landing pages with scoped browsing. Keep IDs in navigation rather than relying on name parsing.

Code evidence: [lib/yutorah.ts:364](../lib/yutorah.ts#L364), [app/secondary-screens.tsx:227](../app/secondary-screens.tsx#L227), [app/teachers/[...slug]/page.tsx:3](../app/teachers/[...slug]/page.tsx#L3).

Verification: Verified public UI and/or current source.

### G11

**Contextual facet counts** · P2 · Missing · Search

Original-site evidence: Search sidebar lists teachers, categories, series, venues, publications and volumes with counts for the current result set. [Open inspected page](https://www.yutorah.org/search/?location=439).

Current project: Directory counts are global; complete search returns empty teachers/topics/series facet arrays.

Suggested completion: Expose counts computed for the active search and let the learner refine it without losing existing filters.

Code evidence: [lib/complete-search.ts:643](../lib/complete-search.ts#L643), [app/advanced-search.tsx:149](../app/advanced-search.tsx#L149).

Verification: Verified public UI and/or current source.

### G12

**RSS and podcast subscriptions** · P2 · Missing · Subscriptions

Original-site evidence: Teacher, series and category pages expose podcast and RSS subscription controls; search also has feed controls. [Open inspected page](https://www.yutorah.org/teachers/Rabbi-Aryeh-Lebowitz).

Current project: Our /api/feed returns JSON recommendations. It is not an RSS podcast feed, and no subscription links are exposed.

Suggested completion: Offer supported official RSS URLs and a copy-feed action first. Verify each feed before advertising podcast compatibility.

Code evidence: [app/api/feed/route.ts:5](../app/api/feed/route.ts#L5), [app/secondary-screens.tsx:128](../app/secondary-screens.tsx#L128).

Verification: Verified public UI and/or current source.

### G13

**Email subscription channel** · P2 · Partial · Subscriptions

Original-site evidence: Email Alerts for teachers/series/categories and a separate homepage mailing-list signup. [Open inspected page](https://www.yutorah.org/series/Daf-Yomi/).

Current project: Google accounts and browser push alerts for followed teachers already exist. Email delivery and collection alerts do not.

Suggested completion: Treat email as a separate opt-in channel. Existing push notifications should remain available.

Code evidence: [app/account-panel.tsx:200](../app/account-panel.tsx#L200), [lib/use-account.ts:396](../lib/use-account.ts#L396).

Verification: Verified public UI and/or current source.

### G14

**Article PDF viewer and print** · P2 · Partial · Study

Original-site evidence: Text article page embeds its PDF and provides Download and Print. [Open inspected page](https://www.yutorah.org/lectures/details?shiurid=1165127).

Current project: Read article opens the file or original page externally. Generated source sheets can print, but article PDFs have no in-app viewer or print control.

Suggested completion: Add an article PDF reading view with a fallback to open/download and an explicit print action.

Code evidence: [app/torah-app.tsx:2327](../app/torah-app.tsx#L2327), [app/torah-app.tsx:2442](../app/torah-app.tsx#L2442).

Verification: Verified public UI and/or current source.

### G15

**All speakers and authors** · P1 · Partial · Metadata

Original-site evidence: Publication results credit all authors, including records with three authors. [Open inspected page](https://www.yutorah.org/publications?publicationid=247).

Current project: RawShiur supports teacher arrays, but normalize keeps only the first teacher, teacher ID and portrait.

Suggested completion: Preserve every credited speaker/author and make each navigable. Check multi-author articles and panel recordings.

Code evidence: [lib/api-types.ts:51](../lib/api-types.ts#L51), [lib/yutorah.ts:139](../lib/yutorah.ts#L139).

Verification: Verified public UI and/or current source.

### G16

**Category hierarchy and attribution** · P2 · Partial · Library

Original-site evidence: Menus organize material under subject branches and nested sections. Shiur details group topic labels under their parent subject. [Open inspected page](https://www.yutorah.org/categories/gemara/Bechorot/).

Current project: Topics are flattened to a group and name; the shiur keeps topic names and only one category label.

Suggested completion: Preserve parent paths and per-topic category identity so similarly named topics stay distinguishable.

Code evidence: [lib/yutorah.ts:176](../lib/yutorah.ts#L176), [lib/yutorah.ts:411](../lib/yutorah.ts#L411), [app/secondary-screens.tsx:301](../app/secondary-screens.tsx#L301).

Verification: Verified public UI and/or current source.

### G17

**Select specific results for batch actions** · P2 · Partial · Search

Original-site evidence: Search has Check/Uncheck All, per-result selection and Add to Queue. [Open inspected page](https://www.yutorah.org/search/?location=439).

Current project: We already have individual queue actions and Queue results for all visible matching audio. There is no selected subset of results.

Suggested completion: Add optional multi-selection for queue/save/playlist actions, with a clear selection count.

Code evidence: [app/torah-app.tsx:1865](../app/torah-app.tsx#L1865), [app/torah-app.tsx:1895](../app/torah-app.tsx#L1895).

Verification: Verified public UI and/or current source.

### G18

**Multiple formats and other languages** · P3 · Partial · Search

Original-site evidence: Independent audio/video/text checkboxes; the inspected result set also includes an OT language value. [Open inspected page](https://www.yutorah.org/search/?location=439).

Current project: Our format filter selects one format and the language UI offers English or Hebrew only.

Suggested completion: Support a set of formats and additional upstream languages when their labels can be resolved. Do not guess what OT means.

Code evidence: [lib/search-filters.ts:3](../lib/search-filters.ts#L3), [app/advanced-search.tsx:262](../app/advanced-search.tsx#L262).

Verification: Verified public UI and/or current source.

### G19

**Public comments** · P3 · Missing · Community

Original-site evidence: Shiur page exposes a comment count and asks visitors to log in to post. [Open inspected page](https://www.yutorah.org/lectures/details?shiurID=1191528).

Current project: We have no public comments interface. Personal library notes are a different feature.

Suggested completion: A link to the original discussion is a small first step. Native posting would need a supported integration or a separate moderation system.

Code evidence: [app/torah-app.tsx:2285](../app/torah-app.tsx#L2285).

Verification: Public control verified; authenticated behavior untested.

### G20

**Ask speaker or author** · P3 · Missing · Community

Original-site evidence: Ask speaker/Ask author control is visible. Clicking it while signed out returns Login to use this feature. [Open inspected page](https://www.yutorah.org/lectures/details?shiurID=1191528).

Current project: No equivalent contact action exists.

Suggested completion: Link to the original action or verified faculty contact route. Do not imply that we can send through YUTorah accounts.

Code evidence: [app/torah-app.tsx:2359](../app/torah-app.tsx#L2359).

Verification: Public control verified; authenticated behavior untested.

### G21

**Original YUTorah accounts and library import** · P3 · Boundary · Accounts

Original-site evidence: Original site offers Google, Facebook and username/password login, registration and password recovery. [Open inspected page](https://www.yutorah.org/).

Current project: Our Google/Supabase identity and library are separate. We already sync our own library, but do not import an original YUTorah account.

Suggested completion: Make the account boundary clear. Investigate export/import only if an upstream supported mechanism exists; adding password login alone would not import the original library.

Code evidence: [README.md:102](../README.md#L102), [lib/use-account.ts:365](../lib/use-account.ts#L365), [lib/account-library.ts:35](../lib/account-library.ts#L35).

Verification: Public control verified; authenticated behavior untested.

### G22

**Editorial campaigns and featured collections** · P2 · Partial · Discovery

Original-site evidence: Homepage has seasonal slides and a separate Featured Content carousel, often linking to collection-filtered searches. [Open inspected page](https://www.yutorah.org/).

Current project: Editors' picks, featured series, daily learning and recommendations exist. The upstream seasonal campaigns and carousel collections are not mapped.

Suggested completion: Bring in editorial campaign titles, descriptions and destinations, adapting links to supported native searches or collections.

Code evidence: [lib/yutorah.ts:336](../lib/yutorah.ts#L336), [app/learning-home.tsx:1255](../app/learning-home.tsx#L1255).

Verification: Verified public UI and/or current source.

### G23

**Special resource landing pages** · P3 · Missing · Discovery

Original-site evidence: Balk Legacy has tefillah/nusach recordings, quick links and selected series. [Open inspected page](https://www.yutorah.org/balklegacy).

Current project: The general topics library can find some underlying recordings, but there is no equivalent curated landing page.

Suggested completion: Start with a link to the original resource. Recreate a curated page only when it serves an identified audience.

Code evidence: [app/learning-home.tsx:1255](../app/learning-home.tsx#L1255).

Verification: Verified public UI and/or current source.

### G24

**Donation links and dedications** · P3 · Missing · Support

Original-site evidence: Support YUTorah link and a daily sponsorship dedication. [Open inspected page](https://www.yutorah.org/).

Current project: Our footer credits YUTorah but has no support link or sponsorship display.

Suggested completion: Offer the original donation link. Show dedications only if there is a supported, current source for them.

Code evidence: [app/torah-app.tsx:2176](../app/torah-app.tsx#L2176).

Verification: Verified public UI and/or current source.

### G25

**Feedback and contextual error reporting** · P2 · Partial · Support

Original-site evidence: Contact form accepts comments, feature suggestions, questions and errors; footer has Report an Error. [Open inspected page](https://www.yutorah.org/Feedback/ContactUs).

Current project: We have privacy/account-deletion email contact but no general feedback or report-this-shiur action.

Suggested completion: Add a report action that includes the shiur ID and page URL, with separate destinations for our interface bugs and upstream content errors.

Code evidence: [app/privacy/page.tsx:59](../app/privacy/page.tsx#L59), [app/torah-app.tsx:2359](../app/torah-app.tsx#L2359).

Verification: Verified public UI and/or current source.

### G26

**Terms and expanded attribution links** · P3 · Missing · Support

Original-site evidence: Original footer has Terms of Use, Privacy Policy, university links and donor attribution. [Open inspected page](https://www.yutorah.org/Home/TermsOfUse).

Current project: We have our own privacy policy and independent-interface notice, but no terms page/link.

Suggested completion: Decide which terms apply to this independent interface and link the relevant upstream content terms. Preserve the independent status.

Code evidence: [app/privacy/page.tsx:7](../app/privacy/page.tsx#L7), [app/torah-app.tsx:2176](../app/torah-app.tsx#L2176).

Verification: Verified public UI and/or current source.

### G27

**Storage and sync explanations** · P2 · Copy defect · Accounts

Original-site evidence: This is an internal consistency issue found during comparison. [Open inspected page](https://yutorah.vercel.app/).

Current project: About the library says saved shiurim, playlists, progress, topics, series and searches stay only in the browser. Current useAccount invokes cloud-library sync for these items.

Suggested completion: Update About and any On this device labels to distinguish signed-out local storage, signed-in cloud sync and pending offline edits.

Code evidence: [app/torah-app.tsx:2760](../app/torah-app.tsx#L2760), [lib/use-account.ts:94](../lib/use-account.ts#L94), [lib/account-library.ts:35](../lib/account-library.ts#L35).

Verification: Verified public UI and/or current source.

## Features already implemented

- Live homepage data, editor selections, recently uploaded shiurim and featured series.
- Teacher, topic and series directories, search autocomplete, typo handling and natural-language filters.
- Duration, language, format, lecture-date ranges, exact phrases, excluded words, ordering and saved searches.
- Persistent audio playback, seek, speed, volume, queue, sleep timer and listening resume.
- Saved shiurim, personal playlists, listening history, learned status, follows and recommendations.
- Own Google account and private library sync are implemented, including topics, series, playlists and progress. Cross-device correctness was not newly tested in this audit.
- Teacher push alerts and per-teacher notification preferences.
- Official timestamped transcripts, generated study notes and transcript search for the locally indexed completed corpus.
- Original source-sheet links, supported video embeds, article downloads and timestamp sharing.
- Generated notes exports and extracted-source-sheet download/print tools.
- Responsive desktop and mobile interface, installable app metadata, keyboard controls and a privacy page.

Do not add duplicate implementations of bookmarks, playlists, audio queueing, daily-learning links, basic source materials, teacher follows, Google sign-in or cloud library sync. The missing work is more specific. For example, Queue results already exists; selecting an arbitrary subset is the gap. Today's Daf already exists as a link; the scanned-page workspace is the gap. Study notes already exist; official chapter summaries and quizzes are different data.

## Important evidence details

- Opening `https://yutorah.vercel.app/search/?series=4031` resolved to `https://yutorah.vercel.app/?view=search` and showed an empty search. The current legacy search route discards the series restriction. Its accepted query aliases also omit the original site's `s` parameter. This is a confirmed runtime and source defect.
- Official collection 15353 identifies the sampled shiur as lesson 13/13 and links to the previous lesson. Collection 15462 exposes newest/oldest ordering, lesson descriptions and related collections with update dates. Neither is equivalent to the generic Daily Shiur or Daf Yomi series.
- The inspected publication lists multiple authors on some articles. `normalize` selects `shiurTeachers[0]` or the first legacy teacher entry. Preserving all attribution needs a data-model change, not only another label.
- General search date filtering uses lecture `date`; trending uses `uploadedAt`. The New this week preset currently sets the general lecture-date range. This can exclude an old recording uploaded recently.
- Our official transcript reader requests `/transcriptions/shiur/{id}/vtt`. It does not consume the chapter, summary or quiz fields shown on the current official site. Existing [official API research](official-yutorah-api-research.md) documents those fields; API request limits and availability should be rechecked when implementing them.
- The About dialog's local-only storage copy contradicts current `useAccount → useLibraryAccount` and `libraryValues`. Older comments about topic/series preferences being local also remain in `lib/account-follows.ts`; the newer general library-sync path handles those preferences separately.
- A donation link, original-site contact action or feed link can be exposed without reproducing the upstream institution's account system. Our own account sync should continue to be described as separate from original YUTorah accounts.

## Retrieval verification

Used Tier 2 graph verification for project `Users-sender-Projects-YU-Torah`, generation `2026-10-13T04:38:39Z`. Checked candidate evidence paths and bounded app/lib/hooks/public scopes. Coverage reported parser gaps in advanced-search.tsx, ui.tsx, transcript-search.tsx, official-transcript.ts, title-index.ts and globals.css; the flagged lines were read directly. Source search/read and route enumeration backed absence claims within the website code. Image/font assets and .DS_Store files excluded from indexing do not establish or contradict application behavior. Graph coverage is best-effort, not proof of completeness.

The companion JSON stores the same findings for tracking; the HTML provides a filterable review view. No automated tests were run because this was a read-only product/code audit.

