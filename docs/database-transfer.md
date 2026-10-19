# Database transfer accounting

The October 19 failure exhausted the old title project's 5 GB outgoing transfer
allowance. Its aggregate usage and the retained application logs cannot establish
which features consumed all of those historical bytes. The chart regression's
99% reduction applies to that fixture, not the project's total traffic.

## Measured baseline

A bounded replay of the packaged production application against the replacement
databases measured JSON-encoded SQL result rows before the new column-byte meter:

| Request | Database result bytes | Response bytes |
| --- | ---: | ---: |
| Completed `rav adler` search, first page | 101,705 | 82,386 |
| Same search, warm process | 0 | 82,386 |
| Second search page | 102,651 | 83,092 |
| Cold autocomplete | 403,845 | 950 |
| Same autocomplete, warm process | 0 | 950 |
| Cold saved chart | 618,813 | 458 |
| Four other chart choices in the same process | 0 | varies |

The search downloaded the same 741 facet rows (57,228 JSON bytes) for each page.
Completed runs now reuse facets for sixty seconds, keyed by database identity,
run checkpoint and all filter predicates. In-progress counts remain uncached;
different filters compute their own counts. This does not change result ranking
or which candidates are checked.

The saved chart's public ranking metadata also remained large after checkpoint
projection. New writes include a separate gzip representation of the public
state; SQL selects that string before transfer. The protected scan representation
retains its full checkpoint. Both readers still accept old raw rows, and older
deployments retain their readable JSON. The existing production checkpoint was
repacked under an unchanged-value and expired-lease guard; its snapshot digest
and scan cursor were preserved. Its compressed public column is 128,068 bytes.

Replaying the same request set after these changes returned identical response
byte counts. Second-page SQL results fell from 102,651 to 45,423 bytes (56% less),
and the cold chart read fell from 618,813 to 128,112 bytes (79% less). These replay
figures use JSON-encoded result rows on both sides; the new production meter
uses raw column bytes, so its totals should not be mixed with those figures.

Eight simultaneous cold catalog readers previously downloaded the same snapshot
eight times. They now share one pending read. Snapshots keep their existing
version keys, expiry, storage limits and refresh behavior.
Forced catalog warmups also skip downloading the old snapshot: these requests
cannot fall back to that value, and publication already reads only its timestamp.

Cold suggestions still need a shared directory and collection lookup. A measured
names-only projection saved only about 6% of their compressed size, so an extra
persisted lookup was not introduced. The 400 KB cold read is a measured cost;
the warm replay used no SQL. The production counters will show its actual share.

## Reusing unchanged public snapshots

Latest catalog reads still check for another publisher every sixty seconds.
The validation query compares the retained content hash in SQL and returns the
payload only when that hash changed. It updates timestamps and expiry even when
identical content was republished. A replacement arrives in that same query,
without another database round trip. Explicit versions remain immutable and
expire at their existing deadline; forced refreshes still bypass old content.

The compressed payloads stay in the existing 128-entry, 4 MiB bounded cache.
Eviction and cold processes still require full downloads. Failed validation can
reuse unexpired content during the thirty-second storage cooldown, preserving
its original timestamp and stale flag. Confirmed removal and hard expiry do not
reuse a cached latest value. An earlier validation cannot overwrite a newer
publication made in the same process.

A read-only capture of the production directory and collection snapshots,
replayed through PostgreSQL in a disposable local schema, returned 399,816 raw
column bytes on each old minute check. The new checks returned 180 bytes with
identical response values and the same two queries. Both cold reads still
returned 399,816 bytes. This is a reduction for unchanged reads in a warm process,
not a forecast of total monthly transfer. Private evidence is saved under
`work/cache-transfer-20261019/private/` and its durable backup.

Complete saved charts that are stale or refreshing now permit thirty seconds of
CDN caching, with browser `max-age=0` and no stale-while-revalidate extension.
Their original freshness labels and fetched timestamp remain in the response.
A newly published chart may take up to thirty additional seconds to appear from
the CDN. Partial charts, live scan requests that are stale or refreshing, and
refresh failures remain uncached. Fresh complete charts retain their existing
cache policy. Background scan and refresh schedules are unchanged.

These changes need no schema migration or new storage service. Moving snapshots
to another store and automatically pausing refresh jobs remain separate choices:
they add publication operations or reduce update frequency. Normal production
counter data should establish their benefit before taking those tradeoffs.

## Production counters

Set `DATABASE_TRANSFER_METRICS=1` on a release after applying
`007_transfer_accounting.sql` with the schema owner. The runtime compatibility
check requires that table; it remains read-only. Runtime roles receive the same
table privileges they already have on search runs.

The shared PostgreSQL adapter counts every managed query, including transaction
control and background work using the website endpoints. The scheduled
source-sheet worker uses the same adapter and enables the meter explicitly;
its direct database secret was moved to the replacement restricted library
connection. Catalog refresh runs every six hours; source preparation is enabled
and runs twice an hour. Query-local type
parsers count returned column bytes before JSON, bigint or date decoding while
preserving the connection's existing parsers. Categories are charts, catalog,
artwork, vocabulary, search results, search state, source processing, notes
indexing, control, and other. Unknown statements stay visible as `other`.

Counters and logs contain fixed category names and aggregate query, row, byte and
error counts. SQL, parameters, IDs, search text, credentials and returned content
are never included. `database_transfer_daily` retains UTC daily totals for
62 days. Notes reads are counted separately and recorded through the library
runtime connection, preserving the notes reader's read-only permissions.

Each standalone operation or transaction writes one small aggregate update after
releasing its application client. The website uses a separate one-connection
counter pool with one-second connection and query timeouts. Counter writes return no rows, are not counted
recursively, and do not add another content read. Failed counter writes produce
a safe warning and a thirty-second cooldown; they cannot turn successful work
into a failed response or repeat an application transaction. Structured
`database_transfer` logs remain available during a counter-store outage.

Read totals with a privately configured library runtime connection:

```sh
npm run database:transfer -- --days 32
```

These are **PostgreSQL column payload bytes**, not the provider's exact billable
network counter. Protocol framing, TLS/authentication, the small accounting
writes, direct owner/maintenance connections and other deployments are outside
these totals. The legacy transcription connection, Cloudflare archive and TiDB
are separate stores. Compare daily application totals with Neon usage while
allowing for its reporting delay; the new project console still displayed zero
usage during the initial replay despite successful database reads.

Private baseline, production-log extracts and verification evidence are in the
ignored `work/transfer-audit-20261019/private/` directory and its durable backup.
