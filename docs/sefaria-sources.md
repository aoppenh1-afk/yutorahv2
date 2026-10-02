# Transcript sources and source sheet preview

The Sources tab lives beside Transcript and Study notes in shiur details. Opening
it checks the **published, timestamped transcript**. Accepted citations appear as
Sefaria links with the transcript wording and every mention's segment timestamp.
Returning to Transcript shows links on those exact words. Nothing is extracted
from generated notes, the shiur title, related texts, or uploaded source sheets.

The optional **Preview source sheet** button adds source text, Hebrew citations,
category paths, edition attribution, and Download sheet / Print / Save PDF.
Choose Hebrew/original, English, or both; short excerpts or complete cited text;
first-mention or category order; and which accepted sources to include. Changing
language reuses loaded editions. Retry fetches only missing texts.
Download produces a standalone HTML document; print uses the same document in an
isolated frame, excluding site navigation and the player. Browser print can save
it as a PDF. The preview can be removed without changing extraction or the tab.

## Research and acceptance policy

Reviewed Sefaria's documentation, implementation, and live endpoints on 2026-10-02:

- [Find Refs](https://developers.sefaria.org/reference/post-find-refs) and
  [Linker request/debug format](https://developers.sefaria.org/docs/linker-api).
  Use `POST /api/find-refs?debug=1&with_text=0` with
  `{text: {title: "", body: transcriptChunk}, lang: "en" | "he"}`. Current
  responses are HTTP 202 task IDs, not immediate citation lists.
- [Async task API](https://developers.sefaria.org/docs/async-task-api): poll
  `/api/async/{task_id}` until `result.body` is ready; preserve pending tasks and
  handle failure, timeout, and retry.
- [Ref metadata](https://developers.sefaria.org/reference/get-ref): validate
  with `/api/ref/{ref}` and use `normalized`, `hebrew`, `url_ref`, `depth`,
  `address_types`, and start/end indexes. Invalid refs can be HTTP 200 with
  `is_ref: false` or a parsing error with HTTP 404.
- [Texts v3](https://developers.sefaria.org/reference/get-v3-texts): retrieve
  `version=primary&version=english&return_format=text_only` only for accepted
  sources when opening the sheet. A broad ref can silently return its first
  section; the returned `ref` must match the requested canonical ref.
- [Sefaria's implementation](https://github.com/Sefaria/Sefaria-Project/blob/master/sefaria/helper/linker/linker.py)
  chooses one model using the majority language when `lang` is omitted. We use
  separate passes for each script present and merge agreeing matches. Live probes
  confirmed Python Unicode character offsets: emoji consume one offset, unlike
  JavaScript's UTF-16 string indexes.

A link requires one successful, unambiguous result whose exact character span
matches the original transcript. Debug data must contain no context ref, ibid,
or inferred resolution parts. Reference metadata must then describe a sufficiently
specific location:

| Mention                                                  | Behavior                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| Gemara Shabbos / מסכת פסחים                              | Omit: missing daf and amud                                    |
| Shabbat 2                                                | Omit: Sefaria may default the missing amud                    |
| Shabbos 2b / שבת ב ע״ב                                   | Accept the canonical Shabbat 2b                               |
| Tosfos daf 2b                                            | Omit: missing tractate and individual comment                 |
| Tosfos on Shabbos 2b                                     | Omit: whole commentary page                                   |
| Tosafot on Shabbat 2b:1                                  | Accept a specific commentary entry                            |
| Commentary with a dibbur hamatchil                       | Accept only if Sefaria resolves one explicit individual entry |
| Genesis 1                                                | Omit: chapter only                                            |
| Genesis 1:1 / בראשית א:א                                 | Accept; deduplicate under Genesis 1:1                         |
| Ibid. / שם / inferred references                         | Omit, even if Sefaria resolves them                           |
| Multiple matches or disagreement between language models | Omit                                                          |

Talmud citations require an explicit amud in the detected wording, including
Hebrew daf-dot/daf-colon notation. Ranges across dapim require explicit, matching
daf/amud endpoints; a side elsewhere in the citation is insufficient. A Talmud
commentary also needs an entry below the daf. Tosafot's schema can have a third
dimension for paragraphs within that entry, so `2b:1` is accepted without
inventing `:1:1`. Other works require all address levels: verse, mishnah, halacha,
individual non-Talmud commentary, etc. A numbered responsum is a complete
bibliographic source even when Sefaria adds paragraph dimensions beneath it. A partially recognized Gemara citation
immediately following a Tosfos/Rashi/Ramban/Rashba/Ritva/Ran/Rosh/Maharsha prefix
is suppressed, including possessive and spoken phrases such as “Tosfos’s comment
on” and “Rashi says in”.

## Pipeline and storage

`advanceSources(db, transcript, fetcher)` owns chunking, task submission and
polling, acceptance, canonicalization, deduplication, and timestamp mapping. The
website and tests call this same interface. `sourcesResponse` reads the transcript
through the existing server-side gateway. Client-supplied prose is ignored, and
`/api/source-text` refuses refs absent from that transcript's accepted list.

Input is split into at most 12,000 Unicode characters with 256-character overlaps.
Original segment text and offsets are retained; no transliteration rewrite, LLM
source generation, quotation search, or related-source expansion is involved.
Matches crossing adjacent segments retain all highlight spans and the first
segment's seek position. Repeated canonical refs retain distinct occurrences;
overlap/model duplicates do not create duplicate timestamps.

Each request completes a bounded pass and checkpoints it in `sources_runs` in
the **search database**, not the read-only transcription database. A lease prevents
simultaneous visitors from submitting the same pending chunk twice. The key
includes policy version, transcript ID, text, and segment timings. Cold servers
can resume; corrected transcripts produce fresh runs. Completed runs last seven
days. A short published-transcript snapshot is cached for 60 seconds in SQL
and reused by polls and text requests, so corrected or removed transcripts are
rechecked within a minute. A requested revision mismatch forces an immediate
gateway check and returns HTTP 409 if the client is stale. Explicit refresh also
bypasses snapshots. Immutable in-memory snapshots reuse their Unicode offsets and
hash. Accepted source texts are cached for one day by canonical ref and excerpt/
full extent. No failed text response is cached. Expired cache rows are pruned at
most once a minute per warm adapter. A crashed request's
lease expires after a minute; an expired five-minute Sefaria task can be restarted
automatically on retry. Every save checks both the lease owner and expiry; a
stale request cannot publish unsaved results or release a replacement owner’s
lease. The UI polls every two seconds and can resume after its poll budget.
Transient network errors and HTTP 429/5xx are retried up to four times with
exponential backoff and Retry-After (seconds or HTTP dates), bounded to one minute.
Changing shiur or hiding the reader cancels waits and requests.

Omissions retain counts by reason and up to 50 timestamped transcript examples.
Examples explain missing locations/comments, incomplete ranges, ambiguity,
inferred locations, partial commentary recognition and invalid matches. They
never enter the accepted source list or a source sheet. Model/overlap duplicates
are counted once for the first 2,000 distinct omission keys.

## Remaining gaps and intentional limits

- **Find Refs finds citations, not the provenance of an arbitrary quotation.**
  An uncited quotation, shorthand, transcription mistake, or unresolved dibbur
  hamatchil may be missed. There is no fuzzy full-text fallback that could add a
  source the speaker never cited. Precision is prioritized over coverage.
- Even an explicit, recognized citation can have been transcribed incorrectly
  or misquoted by the speaker. We identify references; we do not certify that the
  speech matches the source text. The interface labels the result as automatic.
- Timestamps are limited by segmentation: the beginning of the segment containing
  the citation, not a guessed word-level time.
- Sefaria may not hold a work/edition, may fail to link a valid spoken reference,
  or may expose several possibilities for a range. Those references remain omitted.
  An empty list does not mean the recording mentioned no sources.
- The sheet includes primary text and English when available, with returned edition
  names, source links, and license strings. Licenses differ by edition; live Davidson
  versions, for example, report CC-BY-NC. The preview preserves these terms rather
  than assigning one license to all content.
- Sheet text is limited to eight nonempty segments and 12,000 characters per edition,
  in excerpt mode. Complete mode allows up to 500 segments and 200,000 characters
per edition, still labeling any shortened text and linking its complete citation.
Upstream JSON downloads are capped at four million bytes before parsing. Extraction accepts
  transcripts up to two million UTF-16 characters and displays up to 100 unique
  sources, 50 occurrences per source and 300 total occurrences, with a notice when
limits are reached. Per-model candidate queues and metadata caches are bounded;
SQL payloads cannot exceed 900,000 bytes.
- Opening Sources sends transcript chunks to Sefaria. No tracking metadata,
  credentials, generated notes, or shiur title is sent. Opening the sheet sends
  only accepted canonical refs. Text requests share the published-transcript
snapshot and accepted whitelist. The external API must be available; retries
  preserve progress and upstream errors stay server-side.

## Deployment

No Sefaria API key is required. Existing transcript and search connections are
used. Apply the additive cache migration before deploying:

- D1: `npm run db:migrate:local` for development, or the usual remote process for
  `drizzle/0004_sources.sql`. Vercel's D1 setup also applies it idempotently.
- PostgreSQL: apply `db/search-postgres/002_sources.sql` using the **search schema
  owner**. It grants CRUD to the installed `yutorah_search_app` role when present;
  installations with another app role must grant it the same four table privileges.
  The build verifies the table and can create it only when its search connection
  already has DDL privileges. Transcript reader permissions do not change.

The production `yutorah-titles` main branch cache migration was applied through
Neon’s owner SQL editor on 2026-10-02. Verification showed `sources_runs` exists,
`yutorah_search_app` has the four table privileges, and it still lacks schema
CREATE. The prior Vercel migration failure is resolved; new code still requires
a successful preview deployment before merge.

### Optional preparation after publication

The worker can prepare sources immediately after `store.complete` publishes a
transcript and its job heartbeat has stopped. Configure the same private `SOURCES_PREPARE_TOKEN` on the website and
worker, and set the worker’s `SOURCES_PREPARE_URL` to the deployed
`https://YOUR_SITE/api/sources/prepare`. The authenticated POST accepts only a
shiur ID and drives the same published-transcript pipeline; it cannot submit
prose or add refs. It checkpoints one bounded pass per request. Preparation
polls for at most five minutes/120 passes with bounded retries and cancellation.
A failure emits `sources_preparation_deferred`; it never retries/fails an already
published transcription. The normal Sources tab resumes any unfinished run.
Preparation occupies the worker slot after publication, so leave it disabled if
transcription throughput matters more than a warm Sources tab. This integration
is implemented but is not enabled on the installed VM or production website;
the new worker build and matching secrets must be deployed together.

## Verification

`npm run test:sources` runs offline against SQLite and a recorded live response.
Set `TEST_DATABASE_URL` to an isolated PostgreSQL test database to also exercise
the migration, leases, 64-bit epochs, and resumed extraction. Tests cover incomplete
citations, inferred/ambiguous failures, amud and commentary precision, bilingual
disagreement, emoji and cross-segment offsets, overlap deduplication, cache
invalidation, failures/retries, the ref whitelist, escaped exports, text truncation,
and attribution.

Live checks used a synthetic positive transcript and published shiur `929649`
(`RTC Dvar Halacha - Eating Meat At A Kattan's Siyum`). The latter mentions
Pesachim without a daf: both language passes completed with **zero accepted
sources**, as expected. The positive fixture linked Shabbat 2b, Genesis 1:1, and
Tosafot on Shabbat 2b:1 while omitting unspecified Tosfos. Browser checks exercised
the links tab, repeated timestamps, inline transcript links, bilingual text,
HTML download, and the identical print document.

## Real-transcript evaluation

The [evaluation report](sefaria-sources-evaluation.json) replays live Sefaria
responses recorded on 2026-10-02 through the same extraction interface. The
[review set](../tests/fixtures/sources-corpus.json) contains 30 bounded excerpts
from 30 already published shiurim, with source URL, transcript revision, original
segment/character position, timings, agent-annotated expected refs,
excluded/unavailable references and review notes. Excerpts were chosen by citation
keywords. All 30 happen to be Rabbi Aryeh Lebowitz; this is not a random or
representative estimate for the archive. Review was performed by the Codex agent;
independent human review is pending.

The baseline accepts 10 of 18 complete citations whose canonical works are in
Sefaria, with zero incorrect links relative to these annotations (precision 100%,
recall 55.6%). Eight citations are missed. One sample fails because
`/api/ref/Teshuvot haRashba part I 24` consistently returns HTTP 500; this also
blocks its otherwise recognized Rivash citation. Other misses are unrecognized
wording or refs that Sefaria resolved using context despite a complete citation
in the excerpt. Four additional fully named citations were unavailable in the
library lookup and are reported separately from recall. These figures describe
this reviewed excerpt set, not a guarantee for arbitrary transcripts or audio
accuracy. No uncited source was added to improve coverage.

Run `npm run sources:evaluate` to reproduce the report offline. Run
`npm run sources:evaluate -- --record --output REPORT.json` to collect missing
live responses with at most three concurrent transcripts. Recording checkpoints
successful responses and preserves status codes for failed metadata lookups.
Delete `tests/fixtures/sources-corpus-sefaria.json` first to refresh every response;
review and commit changes deliberately. The CI source suite checks that this
sample keeps zero incorrect links and at least its baseline accepted citations.
Expand the set to more teachers, languages and longer transcripts before using
these metrics as a release-wide accuracy claim.
