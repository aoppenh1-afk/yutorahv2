# Official YUTorah transcript API

Verified October 8, 2026, Eastern time. Direct Node fetch and curl requests
succeeded without a browser session, cookies, authorization headers, or an API key.

## Finding

The official API supports complete transcripts and batch retrieval. We do not
need to visit every lecture page or expand chapters.

The official site's `loadData.js` names `https://api.yutorah.org` as its API host.
Its public [Swagger UI](https://api.yutorah.org/swagger/index.html) links to the
[OpenAPI specification](https://api.yutorah.org/swagger/v1/swagger.json).
The specification documents these Transcriptions routes and declares no security
scheme. Access was verified by actual responses, rather than inferred from the schema.

All paths below use `https://api.yutorah.org`.

| GET path | Result | Verification |
| --- | --- | --- |
| `/transcriptions/shiur/{shiurId}` | Complete JSON record for a lecture | HTTP 200 for 1190357 |
| `/transcriptions/shiurim?shiurIds=ID&shiurIds=ID` | Multiple complete records | HTTP 200 for batches up to 120 current seven-digit IDs |
| `/transcriptions/shiur/{shiurId}/vtt` | Complete WebVTT transcript | HTTP 200 for four earlier samples |
| `/transcriptions/shiur/{shiurId}/chapters/vtt` | WebVTT chapter boundaries and titles | HTTP 200 for 1190357 |
| `/transcriptions/summaries?shiurIds=ID&shiurIds=ID` | Dictionary of summaries keyed by lecture ID | HTTP 200 for a four-ID request |
| `/transcriptions/{id}` | Lookup by transcription record ID | Documented, not invoked |
| `/transcriptions/state/{state}` | Complete records filtered by numeric state | Documented, not invoked |

The last route has no documented pagination. An unbounded state query could
return complete word arrays for many records; it is unnecessary for this approach.
Transcription record IDs differ from shiur IDs. For example, shiur 1190357 has
record ID 419120.

## What the JSON includes

- `TranscriptionText` and `RefinedTranscription`, arrays with `word`, `start`,
  `end`, and `probability`. Times are in seconds.
- `Chapters`, with titles, summaries, `start_seconds`, and `end_seconds`.
- `Summary` and `Quiz`, including `ReviewQuestions` and `DiscussionQuestions`.
- `Id`, `ShiurId`, `State`, `CreatedAt`, `UpdatedAt`, `ResponseStoredAt`,
  `TranscriptionSource`, and `RefinedBy`, among other processing metadata.

Preserve both word arrays and upstream provenance. Do not label source content
as locally generated. The existing VTT converter can stage passages with the
same timing boundaries as the official player; JSON additionally provides
word timings, confidence values, and study materials.

For the user's example:

```text
https://api.yutorah.org/transcriptions/shiur/1190357
https://api.yutorah.org/transcriptions/shiur/1190357/vtt
https://api.yutorah.org/transcriptions/shiur/1190357/chapters/vtt
```

The JSON response contained 2,552 word entries, three chapters, a summary,
and quiz content. It was 320,471 bytes. The VTT transcript was 24,298 bytes;
the chapter file was 237 bytes. Both matched the earlier Chrome downloads
byte for byte. Transcript VTTs for 1190833 and 1190347 were also byte-identical
to the Chrome downloads. The older 1158611 example returned the same empty
10-byte VTT.

JSON times and the formatted VTT can differ by a millisecond from floating-point
formatting. For example, a chapter's JSON start is 543.66 seconds while its
VTT start is 00:09:03.659. Retain the original representations rather than
silently normalizing one to match the other.

## Batch proof

This ordinary shell request fetches four records without Chrome:

```sh
curl --fail --silent --show-error --max-time 30 --get \
  'https://api.yutorah.org/transcriptions/shiurim' \
  --data-urlencode 'shiurIds=1190357' \
  --data-urlencode 'shiurIds=1190833' \
  --data-urlencode 'shiurIds=1190347' \
  --data-urlencode 'shiurIds=1158611' \
  --output work/official-yutorah-research/batch-transcriptions.json
```

Use repeated `shiurIds` parameters. Results arrived in a different order from
the request; associate records by `ShiurId`.

| Sample | Response |
| --- | --- |
| Four earlier sample IDs | Four records, 1,875,564 bytes |
| Five recent catalog IDs | Five records, 1,158,464 bytes, 395 ms in one local request |
| Summaries for the four earlier IDs | Three summaries, 1,747 bytes; the empty example was omitted |

The recent IDs were 1190802, 1190889, 1190888, 1190893, and 1190901. Together,
the two JSON batches yielded nine records, eight with actual transcript text
and one empty. This is not a corpus coverage estimate or a sustained throughput test.

All nine records had `State: 4`, including the empty record. State alone is
not an availability indicator. Check the content arrays for usable text.
A summary is useful for discovery but is not a documented guarantee that a
transcript exists. Do not classify HTTP failures as missing content.

## Scalable import approach

### Measured batch boundary

On October 8, 2026, Eastern time, sequential Node GET requests tested larger
batches of unique IDs. Each request included three known transcripts at its end.
Other IDs came from the saved 30-item catalog page and nearby descending numeric
shiur IDs. Some requested IDs had no record. This is a request-size experiment,
not a corpus availability estimate.

| Requested IDs | HTTP | Returned nonempty records | Decoded JSON MB | Total seconds |
| ---: | ---: | ---: | ---: | ---: |
| 25 | 200 | 20 | 9.49 | 1.66 |
| 50 | 200 | 41 | 21.17 | 2.71 |
| 100 | 200 | 91 | 54.55 | 6.84 |
| 120 | 200 | 111 | 71.68 | 9.80 |
| 121 | 404 | — | — | 0.05 |
| 200 | 404 | — | — | 0.03 |

Successful responses retained all three known end-of-request transcripts and
all previously returned IDs included in the larger request. No duplicate or
unrequested IDs were returned. Sizes above are decoded payload bytes divided
by 1,000,000; responses used zstd compression, and wire sizes were not measured.
Total time includes download and JSON validation. These are single measurements,
not sustained rate or concurrency tests. The initial plan included 400 and 800
IDs, but those requests were not sent after the 200-ID failure.

A separate small-response check isolated the query-string boundary: a request
for shiur 1190357 with an ignored ASCII padding parameter succeeded with exactly
2,048 query bytes and returned that transcript. At 2,049 query bytes it returned
the same server 404. The count boundary therefore follows query length rather
than establishing an intrinsic limit of 120 transcript records.

With the documented repeated parameters, a seven-digit ID uses 17 bytes including
its parameter separator. The query is `17 * count - 1` bytes: 120 IDs use 2,039
bytes, while 121 use 2,056. Thus **120 is the observed maximum for seven-digit
IDs in this GET format with no additional parameters**. Shorter IDs can fit more
parameters by arithmetic, but that case was not tested.

Use **50 IDs per batch** as the starting operational setting. It leaves room
under the query limit and had a substantially smaller response than 120 in these
samples. Fifty is a recommendation, not a demonstrated optimal throughput point.
Handle the 404 from an oversized batch as a request failure and split the batch;
never mark every requested shiur as missing. Continue to back off on rate limits
and transient service errors.

At 50 IDs per batch, checking 430,000 IDs takes about 8,600 requests. Full records
can be large, so fewer requests do not imply a proportional download speedup.
The importer should adapt to response size and latency as well as query bytes.

The reproducible probe and detailed evidence are saved locally in
`work/official-yutorah-research/probe-transcript-batches.mjs` and
`work/official-yutorah-research/batch-size-probe-20261008.json`. The latter records
requested and returned IDs, response hashes, sizes, timing, errors, and the
2,048/2,049-byte checks. Full large response bodies were not archived.

### Import behavior

1. Read known shiur IDs from the project's existing catalog.
2. Fetch bounded batches from `/transcriptions/shiurim` and match by `ShiurId`.
3. Save raw records, retrieval timestamps, source identity, hashes, and progress.
   Resume after interruptions; retain older versions when `UpdatedAt` or content changes.
4. Keep missing records, empty records, transient failures, and valid transcripts
   separate. Use refined text when available while retaining the original source.
5. Pace requests, honor `Retry-After`, and retry transient failures with backoff.
   Measure response sizes before increasing batches.

The specification does not state a maximum batch size, rate limit,
incremental-update filter, or pagination for transcription routes. The measured
GET query limit above is runtime evidence. No full-corpus run, production import,
or deployment was started.

The existing metadata API `/api/search/get` also worked from a script. Its page
returned 30 records with no transcript field or availability flag. The response
was 5.51 MB because facets were included despite `getFacets=false`; that parameter
is absent from the current specification. Reusing our existing catalog avoids
repeatedly paying this enumeration cost. The sampled search reported 434,254
results while `/homepage/details` reported 443,723 shiurim. Their scope difference
is unresolved. Neither count is the number of available transcripts.

## Storage measurements

The 71.68 MB large-batch measurement is decoded JSON, not the compressed wire
transfer or the size of an optimized archive. That response used zstd compression;
its wire byte count was not measured.

Local measurements reused eight saved nonempty JSON records, three matching
official WebVTT files, and eight separately generated OpenCode notes files. No
additional API requests or model calls were needed. All eight JSON samples had
byte-identical raw and refined word arrays. The API also repeats property names,
stores per-word confidence values, and includes summaries, quizzes, and processing
metadata. Those fields do not all need to be retained for our transcript reader
and notes pipeline.

The compact passage archive stores source identity, shiur ID, SHA-256 of the
original VTT, and tuples `[startMs, endMs, text]`. It retains every parsed passage,
including exact millisecond boundaries and overlaps. It does not retain individual
word timestamps, confidence values, original VTT layout, or study extras. Gzip
compression of that selected data is lossless; the decision to retain passage
timings instead of the API's word data is a separate format choice.

| Shiur | Full API JSON bytes | Compact timed archive gzip bytes | Parsed passages |
| --- | ---: | ---: | ---: |
| 1190357 | 320,471 | 8,301 | 254 |
| 1190833 | 1,155,491 | 26,210 | 887 |
| 1190347 | 399,078 | 10,479 | 270 |
| Total | 1,875,040 | 44,990 | 1,411 |

That is a **97.6% reduction** across the three matched records while retaining
their complete public-player transcript text and passage timing. The original
VTTs alone gzip to 50,537 bytes in total, so storing compressed VTT is also a
simple option that preserves the complete original VTT bytes.

Across all eight JSON samples, compact word tuples `[word, start, end]` plus
source metadata gzip to 191,158 bytes versus 3,033,498 bytes of full API JSON.
The original word strings and numeric times survive unchanged, while confidence
values and other unused fields are omitted. Plain text alone gzip to 53,968 bytes,
but cannot support local click-to-seek without a separate timing source.

The eight generated notes gzip to 32,086 bytes in total. All measured gzip and
Brotli variants were decompressed and checked byte-for-byte. Compact tuples were
also restored and compared to every selected word/timestamp or parsed VTT cue.
The three passage archives were written, read back, and verified at
`work/official-yutorah-research/ID-compact-timed.json.gz`.

At these small-sample averages, one copy of 430,000 compact timed transcripts
would be about 6.45 GB, and the generated notes about 1.72 GB: about **8.17 GB**
combined in decimal units. Retaining individual word timings instead suggests
about 12.0 GB including notes. These are illustrative extrapolations, not corpus
measurements. The transcript count is unknown, the notes and VTT sample sets
differ, long lectures and other languages can change the averages, and database
rows/indexes, object metadata, replicas, backups, and older versions add storage.

Recommended importer design: keep a single compressed source archive per
version and compressed generated notes, with only IDs, source hashes, pointers,
and queue state in the primary database. Decompress when the notes worker or
reader needs the text. Detect unchanged source hashes before creating another
archive or notes job. Full transcript search requires its own index/storage
budget. This is a measured format proposal; no production storage or schema
changes have been applied.

The reusable measurement script and detailed results are
`work/official-yutorah-research/measure-transcript-storage.mjs` and
`work/official-yutorah-research/storage-size-measurements-20261008.json`.

### Cloudflare storage feasibility

Checked against official Cloudflare documentation on October 8, 2026, Eastern
time. [D1 Free limits](https://developers.cloudflare.com/d1/platform/limits/)
are **500 MB per database**, **10 databases per account**, and **5 GB combined
account storage**. The free allowance is not a single 5 GB database. Existing
databases on the account use some of the same allowance; live account usage was
not checked during this assessment.

The sample-based 430,000-shiur timed-transcript-plus-notes estimate is 8.17 GB of
compressed payload alone, so it exceeds the aggregate Free D1 limit before SQL
rows, metadata, indexes or revisions. Compressed plain text plus notes instead
suggests 4.63 GB, but omits stored timing and leaves little room for database
overhead or full-text search. These remain small-sample extrapolations, and the
number of actually available transcripts is unknown. D1 alone is not a reliable
capacity plan for the complete timed and searchable archive at that scale.

A better Cloudflare design is D1 for small metadata and job/status records,
with compressed timed transcript and notes files in R2.
[R2 Standard pricing](https://developers.cloudflare.com/r2/pricing/) includes 10 GB-month of storage,
1 million Class A operations, and 10 million Class B operations per month.
Egress is free. The free allowance applies to Standard storage. The estimated
8.17 GB archive could fit that storage allowance; longer lectures, existing
objects, retained revisions and request volume can change whether the overall
deployment remains free.

At current Standard storage pricing of $0.015 per GB-month above the allowance,
20 GB stored for a full month costs about $0.15 for storage after the free 10 GB,
before any billable operations or other Cloudflare products. This is a pricing
scenario, not a quote for the user's account.

[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) also limits
Free usage to 100,000 rows written and 5 million rows read per day, counting
index work, and counts both tables and indexes towards storage. The importer
must pace database writes separately from API downloads. Sharding across the
account's databases does not increase these account allowances.

D1 [supports FTS5](https://developers.cloudflare.com/d1/sql-api/sql-statements/#supported-sqlite-extensions)
for full-text search. Compressed payloads need a separate searchable index;
its footprint and write/read cost need a representative pilot before promising
that library-wide transcript search fits Free D1. We can retain a VM search
index if the D1 index is too large. The current PostgreSQL worker and search
schema need adaptation rather than a connection-string change; they use
PostgreSQL extensions and types. No database migration or Cloudflare resource
creation was performed as part of this feasibility check.

### Other options with no additional database bill

Checked October 8, 2026, Eastern time. Free services have resource and operational
limits; a storage allowance is not a guarantee that the entire search and notes
workload will run within its quota.

- **Self-host PostgreSQL on the existing VM.**
  [PostgreSQL has no software license fee](https://www.postgresql.org/about/licence/).
  If the existing VM's hosting is already covered and it has enough spare disk
  and memory, this avoids an additional database subscription. It retains the
  engine used by the current worker and search schema. Hosting, backup capacity,
  maintenance, and the VM's lifetime still need to be covered. Spare resources
  on the actual VM were not verified in this research.
- **TiDB Cloud Starter free instances.**
  [Official plan documentation](https://docs.pingcap.com/tidbcloud/select-cluster-tier/)
  allows five free instances per organization, each with 5 GiB row storage and
  50 million Request Units per month. That is up to 25 GiB row storage spread
  across five instances, not one 25 GiB database. Signup needs no credit card;
  the free plan restricts new connections and throttles at quota rather than
  automatically providing paid capacity. Additional columnar storage is a
  replica for analytics, not another allowance for distinct transcript archives.
  The 8.17 GB compressed archive estimate could fit across multiple instances,
  subject to index and metadata overhead. TiDB is MySQL-compatible, so adapting
  the PostgreSQL worker, sharding, and verifying English/Hebrew search requires
  implementation work and a pilot. No account was created or workload tested.
- **Oracle Cloud Always Free VM with self-hosted PostgreSQL.**
  [Official Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
  include 200 GB of combined boot and block storage in the home region, giving
  more capacity headroom than the managed free databases considered here.
  A free VM may be unavailable due to regional host capacity, and Oracle may
  reclaim idle instances. Those are material limits for relying on it as the
  only copy of a production archive. No tenancy capacity or signup was checked.

For the current PostgreSQL application, the existing VM is the first option to
assess if avoiding another bill is the priority. TiDB is a managed alternative
worth testing if the user wants the data hosted separately. These are zero-cost
options under their stated conditions, not unlimited or guaranteed free hosting.

## Access and remaining limits

The website routes `/lectures/transcript/vtt/{id}` still return Cloudflare
challenges to scripts. The separately documented API routes above return HTTP
200 with ordinary Node fetch and curl. Python's default urllib client received
403 responses with `error code: 1010` on some metadata requests, so it is not
the verified client for this workflow. No browser credentials were copied and
no verification challenge was bypassed.

The total transcript count, sustained request limits, revision policy, and
Hebrew-only coverage remain unknown. Technical accessibility does not establish
redistribution terms.

Raw API samples, VTT files, downloaded public scripts, and `swagger.json` are
saved in `work/official-yutorah-research/`, which Git excludes. See also the
[earlier browser and VTT format investigation](official-yutorah-transcripts-research.md).

## Website integration

The website now reads the official transcript on demand when a shiur's detail
view opens. It calls the existing `/api/transcript?id=ID` route, which prefers
the documented official VTT endpoint. It does not fetch the JSON containing
summaries or quizzes. Existing completed transcripts provide a fallback when
configured and the official text is empty or temporarily unavailable.

`lib/official-transcript.ts` parses VTT into the existing reader's timed passages,
retains exact milliseconds and overlapping cues, removes VTT formatting safely,
and labels the response `source: official-yutorah`. It uses the website's existing
metadata cache for title and teacher. No browser credentials or API token are
required for the official request. There are no database writes or bulk downloads.

Successful responses have a five-minute process/CDN cache and an ETag. Concurrent
reads of the same shiur share one upstream request. Empty results have a short
cache; failures remain uncached errors. Manual refresh bypasses the content cache.
The adapter limits concurrent reads, input/output bytes, cue count, and cue size.
Its redirect mode is `manual`, which is supported by the Workers runtime; HTTP
redirects are rejected rather than followed.

The reader displays official text with its timestamps, click-to-seek, local
text download, and a complete-text link. Official text does not start notes polls
or offer the existing notes and Sources tabs. Existing generated transcripts
retain their study tools. Global transcript search continues to use the existing
archive/index; viewing an official transcript does not automatically add it there.

The complete-text route retains the official source and VTT hash in its URL.
A pinned official hash that no longer matches returns an explicit error instead
of silently substituting another version. Official API reads have no historical
archive or immutable-cache guarantee. Existing archive version requests continue
to use the archive, without being replaced by current official text.

Validation of the built Workers website returned 254 passages for 1190357,
887 for 1190833, and 270 for 1190347. The empty 1158611 example returned 404.
The complete-text request succeeded and a conditional repeat returned 304.
The collaborative browser displayed the official transcript from 1190357.

Checks passed: nine server tests covering official retrieval and the existing
gateway, five VTT parser tests, all 32 player/browser tests, TypeScript, targeted
lint, and the production build. The browser regression checks seeking, the
complete-text URL, absence of notes polling, and retention of loaded text after
a refresh failure. Production deployment remains a separate step.
