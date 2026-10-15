# Source creator

The Sources tab in a shiur checks the same transcript displayed by the website,
including official YUTorah VTT, plus the published study notes. It finds explicit
citations, searches distinctive quoted passages, and assembles a source sheet.
It works with either transcript or notes alone. Nothing is inferred from the
shiur title, teacher, topic, or recommended recordings.

## Turn either output off

Both outputs are enabled by default. In Sources, open the options menu and choose
**Settings**. The independent **Sefaria links** and **Source sheets** checkboxes
control this device. Turning both off stops
source processing in that browser. Preferences survive page reloads.

To disable an output for the whole site, set either server environment variable:

```sh
SOURCES_LINKS_ENABLED=false
SOURCES_SHEETS_ENABLED=false
```

Set just one to `false` to keep the other. `0`, `off`, and `no` also disable an
output. Server switches take precedence over browser preferences. With links off,
sheets still load source text and retain edition attribution. Source headings in
the viewer and downloads remain plain text. With sheets off, transcript and
notes links still work. Disabling both hides Sources after settings load and
prevents source API reads. No Sefaria API key or language-model credentials are
required.

On Neon, uncached interactive sheet generation and source-text cache misses also
check the allocated database limit before writing. They leave at least 16 MiB
of headroom for concurrent bounded requests and index maintenance. Previously
prepared sheets and cached source texts remain readable when new work stops.
This protects the shared database while notes-search capacity is unresolved;
it does not enable the scheduled preparation job.

## Sheet interface

Sources opens directly to a source sheet in the site's monochrome study reader.
Hebrew is the default. The **English** checkbox adds English alongside the
original text. There is no separate references view.

**Download** opens a compact dialog with format and language choices. PDF, Word,
standalone HTML, and print are supported. Title, introduction, and excerpt/full
text choices are collapsed under **More options**. Missing text requires an
explicit choice to include citations only. All formats retain edition attribution
and licenses, and exports made during checking are labeled partial.

The options menu contains **Edit sources**, **Add source**, **Review possible
sources**, refresh, and settings. Editing reveals selection, ordering, and
personal notes. A manually added or corrected reference must pass Sefaria
validation and stays labeled as an addition. Review candidates require this
validation too. Published notes and manual additions never invent recording
times. Transcript occurrences still link to the recording, and verified sources
remain linked in transcript and notes text when links are enabled.

Sheet edits are stored per shiur on the current device. They are not published,
sent to Sefaria, or synced to the account. Download a copy to share it or move it
between devices. Browser storage failures are disclosed without blocking editing.
Old sheet edits migrate to the new Hebrew default; subsequent language choices
are remembered.

## Citation policy

The citation adapter uses Sefaria's Linker in each script present, plus the spoken
reference parser. Every proposal is checked with reference metadata. Matches
must correspond to the original wording and offsets. Inferred locations, ibid,
model disagreements, incomplete ranges, and ambiguous references are excluded.

Nearby parts of an explicit citation can cross sentence and VTT cue boundaries.
A combined mention must fit within 450 Unicode characters, span at most 60 seconds
between its first and last cue starts, and cross no cue gap over 15 seconds.
Another named source stops the spoken parser's search. Processing batches can
contain more speech; these limits apply to each accepted mention. Only source
and address words become links. English numbers, Hebrew numerals, common spoken
work names and transliterations, and vocalized Hebrew are supported.

The section of Shulchan Arukh, Tur, Beit Yosef, or Taz must actually be supplied.
“Shulchan Aruch, siman daled, seif daled” alone cannot pick Orach Chayim. A named
chapter, siman, or commentary page can be retained at the detail supplied. A daf
without an amud refers to the whole daf. A later seif refines the same earlier
siman mention instead of duplicating it; independent mentions remain separate.

Notes paragraphs are independent citation contexts. Markdown destinations,
code, and HTML are masked without changing character positions. Notes links
are added to unchanged text leaves, without nesting links or changing Markdown.
The reader checks the notes version before applying highlights. Transcript
highlights also check the original span text before linking it.

## Reading and quotation policy

Hebrew and Aramaic runs can be searched without quote marks. English passages
need quote marks or a reading cue such as “the text says.” A passage needs at
least seven Hebrew/Aramaic words and 32 normalized characters, or ten English
words and 50 characters, with at least four distinct informative words.
“אמר רבא” does not qualify and does not trigger a search.

The verifier normalizes vowels, cantillation, punctuation, and whitespace while
preserving word order. Readings can cross nearby transcript cue boundaries.
Long readings produce overlapping anchors of up to 14 words at 10-word intervals,
so a clean part of a reading can verify a specific segment even when other words
cross Sefaria segment boundaries or contain transcription mistakes.
Clear Hebrew reading cues add one targeted anchor after the introduction. The
original opening remains a candidate, because phrases such as “שנאמר” can also
belong to the source itself. Every anchor must meet the same specificity rules.

If the nearest explicit citation names one exact segment, the verifier can check
its complete text directly. It accepts only an exact normalized word match in
that canonical segment. Chapters, dapim, conflicting wording, and missing text
cannot use this shortcut. Otherwise it searches the Sefaria text library with an
exact phrase query and requests complete hit counts. It then:

1. Rejects partial, timed-out, malformed, or truncated search results. At most
   60 raw search hits are inspected; a larger result is left for review.
2. Deduplicates editions of the same reference. Different locations remain
   different candidates. Search rank does not decide which is correct.
3. If needed, uses the nearest explicit preceding citation within 450 characters and
   60 seconds to restrict matches to that cited location. A title or topic alone
   cannot establish this context. Multiple remaining locations are ambiguous.
4. Validates the canonical reference at segment depth and fetches that exact
   source text. At least one complete returned edition must actually contain
   the normalized words in order. A guessed chapter or default first section
   cannot verify a reading.

When a search match comes from another edition, up to two indexed English or
Hebrew editions can be fetched by their exact version titles. The fetched
reference, edition identity, language, and complete text must match. A substituted
edition or search snippet alone never establishes verification.

This is deliberately exact text matching. Paraphrases, translated summaries,
transliterated readings, and transcription errors can be missed. They are not
turned into approximate automatic links. Repeated passages and missing Sefaria
texts remain reviewable. Notes evidence establishes what appears in the notes;
it does not claim that the teacher said it in the recording.

## Incremental processing and failure recovery

`lib/source-creator.ts` owns the new workflow. `lib/source-windows.ts` groups up
to 32 transcript units or roughly 9,000 characters, with up to 450 characters of
lookbehind bounded by recording time. Large individual cues are split with
overlap. Unchanged window text and timings reuse completed verification across
appends and corrections. Quotes have their own cache keyed by words and explicit
context. A content hash identifies each complete input snapshot, including notes.
Changed text, timings, notes, or policy cannot reuse an incompatible result.

Each request advances up to six stages within a soft six-second budget and awaits
all work. It yields immediately when a Sefaria task is still pending. Quotation
verification runs in batches of three; identical normalized words and citation
context share an in-flight request. Successful results are checkpointed even
when another quotation fails, and retries reuse completed verification.
Different passages from the same canonical source share reference metadata and
text lookups. Verified full text populates the sheet cache too. Concurrent local
requests share a download; an excerpt can use an in-progress full-text request.
Warm sheet requests use validated cached text without another Sefaria request.
Expired entries are revalidated. Original excerpt limits and attribution remain.
SQL leases prevent
duplicate submissions by simultaneous visitors. There are no background promises
that can disappear when a server request ends. Source results, window results,
and pending Sefaria tasks use the existing writable `sources_runs` table in the
search database. The read-only transcript database is not modified.

The client continues available local work after 150 milliseconds and respects
normal polling backoff when waiting for remote work. It pauses when hidden and cancels on navigation
or when both outputs are disabled. Completed snapshots are checked again each
minute for newly available notes or revised transcripts. Inputs explicitly
marked incomplete are checked every 15 seconds. Upstream providers must expose
new text before this app can discover it; the creator does not transcribe audio.
A changed transcript identity refreshes the reader before applying new spans.
Retries preserve the last verified sources and continue saved work.

The public pipeline accepts only server-loaded published inputs. Request query
strings cannot supply prose for extraction. Manual reference validation is a
separate endpoint. Text retrieval allows numbered canonical references from
Sefaria's public library, including manually added sources, independently of a
transcript run. Downloads and private sheet comments are assembled in the browser.

Limits are visible: twelve quotation candidates per window, 150 distinct sources,
60 occurrences per source, and 80 displayed review examples. Legacy citation
batch limits also propagate to the result. Intermediate results last 30 days.
Completed prepared sheets last one year and are reused only when the current
input hash matches. Source texts are cached by canonical ref and extent for one
day. Capacity pruning bounds transient rows while preserving prepared sheets
and the preparation queue. Expired work is removed. Errors do not become
successful matches.

## Prepare sheets on GitHub Actions

The `Prepare mekoros` workflow runs the same detector directly on a GitHub-hosted
runner every 30 minutes. It fetches published transcripts and notes from the
website and verifies sources with Sefaria. It needs no AI worker and does not run
on the notes VM. It does not generate notes or transcribe audio.

Add the repository Actions secret `SOURCES_DATABASE_URL` using the writable
production search database connection. This is the `yutorah_search_app` role in
`yutorah-titles`, not the read-only transcript database. No credentials belong in
workflow files, variables, logs, or artifacts. `SOURCES_SITE_URL` is an optional
repository variable overriding `https://yutorah.vercel.app`.

After merging the workflow to the default branch and deploying the source
creator, run it manually with **Only verify database configuration** selected.
That checks the connection and table with a read-only query. Then run normally,
optionally supplying comma-separated shiur IDs to prepare first. Enable the
repository variable `SOURCES_PREPARATION_ENABLED=true` only after these checks.
The scheduled job allows 20 minutes and 60 shiur attempts per run. GitHub scheduling may be
delayed. The website still handles an uncached shiur on demand.

Every run checks the newest catalog page and advances a separate archive cursor.
The queue, cursor, detector checkpoints, and prepared sheets live in the shared
`sources_runs` table, so the next runner resumes them. An incomplete catalog page
does not advance its cursor. A database lease prevents overlapping runners and
blocks an expired owner from overwriting queue state.

Complete inputs are rechecked after six hours, growing transcripts after 15
seconds, missing inputs after 24 hours, and temporary failures after five minutes.
These are eligibility times; the next scheduled run performs the work. Every
fourth attempt prioritizes eligible rechecks, so an archive backlog cannot starve
later notes or corrections. Changed inputs invalidate the prepared sheet. A run
stops after three consecutive temporary failures and preserves its checkpoints.
Source text is warmed on the runner when sheets are enabled. Site feature
switches apply to the runner too.

For another machine with the secret already in its environment:

```sh
npm run sources:prepare -- --check
npm run sources:prepare -- --ids 929649 --catalog-pages 0
```

Disable the workflow in GitHub Actions to stop scheduled preparation. Existing
verified sheets remain available. Prepared sheets share the existing 32 MiB
cache cap with completed detector results and source texts; coordination rows
and active leases are preserved. The scheduled runner checks database size
before each upstream request and stops at `SOURCES_MAX_DATABASE_BYTES`, which
defaults to 500,000,000 bytes in Actions. Adjust that repository variable only
after verifying allocated storage and headroom. No new database migration is
required.

## Endpoints and files

- `GET /api/source-creator/features`: independent server switches.
- `GET /api/source-creator?id=…`: current published transcript and notes, verified
  references, evidence, review reasons, warnings, and checkpoint progress.
- `POST /api/source-creator/verify` with `{ "ref": "Genesis 1:1" }`: validate a
  manual addition without claiming recording evidence.
- `GET /api/source-creator/text?ref=…&extent=excerpt|full`: canonical source text
  and edition attribution, gated by the sheets switch.
- `/api/sources` and `/api/source-text` retain compatibility aliases to the new
  routes. Authenticated `/api/sources/prepare` warms the new pipeline.

`lib/sources.ts` and `lib/spoken-sources.ts` provide the conservative citation
adapter. `lib/source-quotes.ts` verifies readings. `hooks/use-source-creator.ts`
coordinates client polling and output preferences. `app/sources-panel.tsx`,
`hooks/use-source-sheet.ts`, `lib/source-draft.ts`, and `lib/source-sheet.ts` own
sheet editing and exports.
`lib/source-text-handler.ts` serves validated cached texts and checks cache misses.

## Request-cost regression checks

The four-reading fixture in `tests/source-creator.test.ts` finds four passages
from one source. Before shared verification it made 14 upstream requests,
including four metadata reads and four identical text downloads. It now makes
eight requests with one metadata read and one text download, a 43% reduction.
Opening that cached sheet makes zero additional upstream requests. These are
deterministic request counts, not a claim about every shiur's completion time.

## Storage setup and checks

No new database migration is needed. The existing sources migration must have
been applied to the writable search database:

```sh
npm run db:migrate:local
npm run test:sources
npm run test:notes-export
npm run lint
npm exec tsc -- --noEmit
npm run build
```

On managed PostgreSQL, use the existing search-schema migration procedure,
including `db/search-postgres/002_sources.sql`. No transcript-store migration or
notes-worker change is required. The optional PostgreSQL integration test needs
its configured test database; it is skipped when that database is unavailable.

Sefaria endpoints were checked against the official documentation and live
search on 2026-10-15:
[Find Refs](https://developers.sefaria.org/reference/post-find-refs),
[reference validation](https://developers.sefaria.org/reference/get-ref),
[search](https://developers.sefaria.org/docs/search-api), and
[Texts v3](https://developers.sefaria.org/reference/get-v3-texts).
