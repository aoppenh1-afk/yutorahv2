# Official YUTorah transcript investigation

Verified October 8, 2026, Eastern time, through the user's existing Chrome tab
using the Codex Chrome extension, then through direct API requests.

**Update: direct and batched retrieval now work through the documented official
API without Chrome.** See [API endpoints and batch proof](official-yutorah-api-research.md).

## Result

**Yes. Full official transcripts can be downloaded with exact passage timings
and separate chapter timings, without signing into YUTorah.**

The lecture page's `<track>` elements and the browser's observed resource
inventory identify these two routes:

```text
https://yutorah.org/lectures/transcript/vtt/{shiurID}
https://yutorah.org/lectures/chapters/vtt/{shiurID}
```

The first response is a WebVTT transcript. The second is a WebVTT chapter list.
Both files were downloaded through the extension's supported
`locator.downloadMedia()` method on those track elements. No session cookies
or credentials were extracted.

The page was visibly logged out and its inline script declared
`userAuthenticated = 0`. The downloaded
[official loader](https://yutorah.org/js/vtt-transcript.js?v=GI-86qYLhAK9OpM4SjUZh0PdwhSIPyuzA4DqcO6CXbQ)
uses ordinary `fetch(url)` and `r.text()`. It adds no YUTorah bearer token or
API key. Cloudflare verification still matters; public content does not imply
unrestricted automated retrieval.

## Downloaded and verified samples

- [1190833](https://yutorah.org/lectures/new/1190833), Rabbi Eliav Silverman,
  The Nature of the Issur of Refuah B'Shabbat. Transcript: 89,305 bytes,
  887 cues, ending at 43:43.920. Chapters: four, starting at 0:00.000,
  3:30.060, 11:10.860, and 21:25.400. 125 cues contain Hebrew characters.
- [1190357](https://www.yutorah.org/lectures/new/1190357), Rabbi Benzion
  Kermaier, From Rosh Hashanah to Simchat Torah 5787. Transcript: 24,298 bytes,
  254 cues, ending at 19:22.980. Chapters: three, starting at 0:00.000,
  9:03.659, and 13:42.720. This is the user's screenshot example.
- [1190347](https://www.yutorah.org/lectures/new/1190347), Rabbi Ally Ehrman,
  אמרי אמת תרס"ו שמיני עצרת. Transcript: 40,636 bytes, 270 cues, ending at
  28:30.859. Chapters: three. This is mixed English/Hebrew speech, with
  Hebrew text in 163 cues, rather than a verified Hebrew-only sample.
- [1158611](https://www.yutorah.org/lectures/v5/1158611/), an older lecture.
  Its transcript download contains only `WEBVTT` and blank lines, 10 bytes,
  with zero cues. The page's transcript container has the `is-empty` class.
  A Transcript button alone is not an availability indicator.

The three complete transcripts contain 1,411 cues and total 154,239 raw bytes.
This is a small verified sample, not a corpus coverage estimate.

## Format and UI behavior

An actual transcript cue is:

```vtt
WEBVTT

1
00:00:00.000 --> 00:00:06.960
Okay, the topic for today is the gezeira the d’Rabanan of the refuah b’Shabbos.
```

Cues have numeric identifiers, start/end timestamps to milliseconds, and UTF-8
text. The original files use CRLF line endings. Hebrew, niqqud, punctuation,
and repeated words are present in the downloaded text.

The chapter file uses the same timestamp syntax, with a chapter title as its
cue text. For the screenshot example, the exact first chapter ends at
9:03.360 and the second begins at 9:03.659. UI duration badges are rounded;
they must not be used to reconstruct exact boundaries.

The loader fetches the complete transcript and chapter file together, assigns
sentences to chapters, and renders every chapter's text into the DOM. Expanding
a chapter reveals already-loaded content. We do not need to scrape each
chapter separately. The UI rounds passage start times down to whole seconds,
so downloading VTT preserves more timing precision than displayed timestamps.

The loader sets `is-empty` when no transcript cues exist. When a transcript
exists but chapters do not, it creates one Content chapter. Transcript
availability and chapter availability must be checked independently.

Some official cues slightly overlap. The samples contain one adjacent overlap
in 1190833 and three in 1190347. Preserve source timings instead of clipping
ends to the next start time. No structured speaker or language fields were
observed in these samples. Speaker labels inside the text remain intact;
inferred language must not be described as official metadata.

## Local artifacts and converter

Raw transcript/chapter files, the downloaded loader, an empty-file sample,
and a manifest are under `work/official-yutorah-research/`, which Git excludes.
Each complete sample has staging JSON containing the shiur ID, source identity,
official page and file URLs, retrieval time from the downloaded file's
modification timestamp, raw-file SHA-256 hashes, transcript segments, and
chapter titles/timings. Raw VTT remains the authoritative source.

The converter and focused parser tests are in
[scripts/convert-official-yutorah-vtt.mjs](../scripts/convert-official-yutorah-vtt.mjs)
and [its tests](../scripts/convert-official-yutorah-vtt.test.mjs).
It reads local downloads, rejects HTML/challenge responses and malformed
cue timing, preserves milliseconds and overlaps, and writes staging JSON.
It refuses to overwrite an existing output file and has no database connection.

Example:

```sh
node scripts/convert-official-yutorah-vtt.mjs \
  --shiur-id 1190357 \
  --transcript work/official-yutorah-research/1190357-transcript.vtt \
  --chapters work/official-yutorah-research/1190357-chapters.vtt \
  --output work/official-yutorah-research/1190357-converted.json
```

Segments use the project's `startMs`, `endMs`, `text`, `speaker`, and `language`
representation. Speaker fields stay null. Conservative language tags derive
from the passage's visible script; mixed passages remain null. Transcript
`durationMs` is the maximum cue end, not a separately verified audio duration.
A publication must reconcile this with media metadata if needed.

The current parser in `packages/transcription/src/transcript.ts` accepts
model-produced timestamp-prefixed text, rather than VTT. Official VTT should
be converted directly to segments. The public-content format already accepts
these segment fields. Publication still needs lecture metadata, a transcript
version identity, and the normal archive validation/hash-verification flow.
Keep the official source distinct from local generation and retain existing
transcript versions.

No production database, website deployment, or published transcript changed.

Verification passed: five focused parser tests, lint, and diff whitespace checks.
All three complete samples matched their staged text and chapter data exactly,
their raw-file hashes matched, and their segments passed the project's existing
`validSegments` validator without changing source timings.

## Retrieval constraint and remaining questions

Python and curl requests to the verified VTT routes still returned HTTP 403
with `cf-mitigated: challenge` from this environment. Downloads worked in the
user's normal Chrome session. Fresh Chromium, Chrome, and native Safari
sessions had previously remained at verification. The separately documented API was subsequently verified with direct Node and
curl requests, including batches. See the linked API investigation above. The investigation used supported browser downloads
without bypassing verification or copying browser credentials.

Direct API retrieval is verified. Before a full import, measure sustained
retrieval, availability across a representative bounded sample, and upstream
request limits. Do not classify a challenge or network failure as an empty
transcript. The total official transcript count, revision policy, and
Hebrew-only coverage remain unknown. Technical accessibility does not establish
redistribution terms.

Summaries, quizzes, and reflections are visible in the lecture DOM. The subsequent
API investigation verified JSON records containing summaries, quiz review questions,
and discussion questions alongside the word-level transcripts and chapters.
