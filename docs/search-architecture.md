# Intent, typo, and partial-word search

Updated October 1, 2026. The public Vercel website uses managed PostgreSQL;
Cloudflare/Sites and local development use D1. No model credentials are required.

## Learning from the title index

`lib/title-index.ts` builds a persistent vocabulary from actual archive titles.
Each title contributes distinct words and contiguous two/three-word phrases.
Short deletion keys retrieve bounded spelling candidates, while compact phrase
keys recover missing or extra spaces. The shared matcher validates the whole
word; title frequency breaks ties between equally close spellings. This follows
the [index-derived correction approach documented by Elasticsearch](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/search-suggesters)
and [SymSpell's deletion-based candidate lookup](https://github.com/wolfgarbe/SymSpell).
There is no per-word mapping for newly indexed vocabulary.

Every fetched search page updates this vocabulary transactionally. Existing
query-cache titles are seeded in bounded passes; the learned catalog survives
query-cache expiry. Repeated titles are counted once. Title edits replace their
old contribution. A request looks up only its candidate words and phrases, rather
than loading the full archive into the website or browser. Quoted spans, numbers,
and ambiguous word boundaries remain literal. An exact indexed spelling does not
expand to neighboring words simply because they are popular.

If that exact indexed spelling yields zero source results under the selected
teacher/topic/series, search may offer a verified close spelling as **Did you
mean**, while keeping the original results. Recognized subjects, numbers, and
explicit quotes remain protected. Exact archive words also protect request
interpretation before fuzzy correction. Suggestions and dictionary protection
are snapshotted on the search run. The search box keeps the submitted text, and
an exact-wording action bypasses rewriting. See [the correction research and
behavior](search-corrections.md).

The upstream index contains the full archive; the application's new learned
vocabulary covers the titles ingested so far. `lib/title-catalog.ts` and
`npm run search:index` provide a bounded, resumable scan of that existing index
to build coverage independently of user searches. Each page commits its titles
and cursor together; a failed request leaves that page available for retry.
Resumed passes also refresh the newest page. A completed scan can be run again
to refresh changed titles. No audio or transcripts are downloaded by this scan.

Apply D1 migration `drizzle/0002_title_vocabulary.sql` before running the upgraded
website. For local development:

```sh
npm run db:migrate:local
npm run search:index -- --local --pages 20
# Complete a fixed-ID snapshot of the entire public title archive:
npm run search:index -- --local --bulk --all --pages 100 --concurrency 4
```

Without `--local` or `--sqlite`, the importer uses `SEARCH_DATABASE_URL` when
configured for managed PostgreSQL. Otherwise it uses `CLOUDFLARE_ACCOUNT_ID`,
`SEARCH_D1_DATABASE_ID`, and `SEARCH_D1_API_TOKEN` as the existing HTTP storage
adapter. `--sqlite PATH` chooses a specific local search database; `--restart`
restarts its scan without deleting learned titles. The command reports current
coverage, the source total, and the next page. Backfill is an operator command,
not an additional archive scan on every user search.

Full migrations also apply `drizzle/0003_title_import_checkpoint.sql`. Bulk mode
uses the public site's `Search/GetSearchResults` endpoint with its documented
numeric-ID facet filter and visible-teacher filter. It captures the lowest and
highest current IDs, then fetches disjoint ranges containing at most thirty IDs.
Each response must contain every result in its range, with unique, valid IDs.
Up to four requests run concurrently by default; transient failures retry with
backoff. Results, scanned counts, and the contiguous checkpoint commit together.
New higher-ID uploads cannot move the snapshot's finish line. A completed
snapshot stays complete until explicitly restarted; ordinary user searches keep
learning new titles in the meantime.

Completion requires an audit against both the source's bounded total and the
stored title count within those boundaries. A cursor reaching the final ID alone
cannot mark the migration complete. The public site's search endpoint exposes
slightly more public records than the newer metadata API; the bulk vocabulary
includes them, while user result retrieval continues to use the existing API.

For a Vercel or Sites database, `npm run search:transfer -- SNAPSHOT.sqlite SITE_URL`
copies an immutable, completed local snapshot over HTTPS. Set the secret
`SEARCH_INDEX_TRANSFER_TOKEN` in both the operator environment and the deployment, enable
`SEARCH_INDEX_TRANSFER_ENABLED=true` in the deployment only during the transfer, and set
`SITES_API_TOKEN` only in the operator environment for the private site's access
gate. Vercel does not require `SITES_API_TOKEN`. Titles rebuild document frequencies through the same database triggers;
unique spelling keys are copied separately in bounded batches. Both phases
checkpoint transactionally and safely retry committed batches. Only keys for active
vocabulary are transferred. Completion expires finished query caches so requests
can immediately use the imported vocabulary, while pending searches retain their
original expansion. Completion checks
title coverage and spelling-key coverage before marking the archive complete.
Set `SEARCH_INDEX_TRANSFER_ENABLED=false`, remove the deployment's transfer secret,
and redeploy after verification. The switch defaults to off and disables
`/api/search-index` even if the hosting runtime retains an old secret binding.
Verify that the old credential gets HTTP 404 for both GET and POST. The endpoint
accepts only these bounded archive operations.

This learns archive vocabulary and word boundaries. Open-ended meaning matching
still requires title embeddings and an inference model; a spelling dictionary
alone cannot infer a connection between two completely different phrases.

## Vercel PostgreSQL migration

The Vercel runtime selects managed PostgreSQL when `SEARCH_DATABASE_URL` is set.
`lib/search-postgres.ts` preserves bound values, atomic batches, numeric counts,
and the shared module's SQL behavior. A small pool and a dedicated search role
keep credentials server-side. The runtime role has CRUD access only to the
`yutorah_search` schema; it cannot change transcription data or schema definitions.
Builds require no database connection. Apply owner migrations with
`npm run search:schema:migrate`, then run `npm run search:schema:check` with
the runtime role before activating the release. The owner command tracks
applied files and serializes overlapping migrations. See the
[performance release ordering](codebase-performance-implementation.md#release-ordering).

Apply `db/search-postgres/001_search.sql` with a migration/owner connection.
The logical spelling-key view has exactly the same keys as the SQLite index.
Compact phrase keys derive from each term; prefix and deletion keys are grouped
per word. B-tree and GIN indexes retrieve the same bounded candidates and title
frequencies. Title edits update document frequencies; transactional word-key
merges preserve words split across ingestion batches. Query expansions remain
snapshotted so newly learned titles cannot change a resumed search.

For the initial migration, prepare a completed, immutable title snapshot:

```sh
npx tsx scripts/prepare-search-postgres.ts SNAPSHOT.sqlite work/search-copy.sql
# Set SEARCH_MIGRATION_DATABASE_URL privately to an owner/migration connection.
# PostgreSQL client tools (psql) are required for COPY and audit.
npx tsx scripts/import-search-postgres.ts work/search-copy.sql
npx tsx scripts/verify-search-postgres.ts work/search-copy.sql.audit.json work/search-audit.json
```

The import refuses a nonempty destination, copies all title/vocabulary data in
one transaction, and restores the catalog trigger before committing. SHA-256
audits compare every logical row, including the reconstructed spelling-key view,
with the SQLite source. The import does not copy expired query caches or modify
transcripts. Create the restricted runtime role, set its pooled TLS connection
as `SEARCH_DATABASE_URL`, then deploy and verify public searches.

Production's completed snapshot has 433,693 titles, 1,560,167 vocabulary entries,
and 3,032,518 logical spelling keys. The provider enforces a 512 MB project size
limit despite Vercel's integration page advertising 1 GB. The compact index and
existing transcript data fit, but the free plan still has finite storage and
compute capacity; monitor usage as query caches and transcripts grow.

Remove Vercel's unused `CLOUDFLARE_ACCOUNT_ID`, `SEARCH_D1_DATABASE_ID`,
`SEARCH_D1_API_TOKEN`, `TRANSCRIPT_API_URL`, `TRANSCRIPT_API_TOKEN`, and
`SEARCH_INDEX_TRANSFER_TOKEN`. Set `SEARCH_INDEX_TRANSFER_ENABLED=false` and
verify the old transfer credential receives HTTP 404. Keep local rollback
databases and completed snapshots. No paid hosting plan is enabled.

## Intent interpretation

Everyday requests are interpreted before conversational cleanup. A shared domain
model in `packages/yutorah-core/src/search-concepts.ts` connects subjects such as
anger, anxiety, grief, marriage, gossip, gratitude, character development, and
honoring parents to terminology used in the archive. For example, a request to
stop gossiping searches both gossip and lashon hara; a request about coping with
loss also retrieves aveilus and nichum aveilim. Recognized request phrases and
unambiguous one-edit subject corrections are disclosed in the search plan.

Related forms are alternatives within a subject, including compound concepts.
Distinct subjects remain required: anxiety on Shabbat searches anxiety/bitachon
**and** Shabbat, while keeping teacher, duration, language, and other filters.
Connecting words such as “on,” “of,” and “the” do not become mandatory archive
keywords. A query containing only connecting words remains literal. Quoted
phrases and exclusions retain their exact whole-word behavior.

Metadata retrieval, smart transcript clauses, suggestions, title refinements,
ranking, and highlights share these concept groups. Direct wording ranks above
related concepts. Compound related forms must occur together for local matching;
incidental mentions of “lashon” and “Har Gerizim” cannot satisfy “lashon hara.”
The results display the related topics used for retrieval.

The curated domain connections supplement the learned title vocabulary. They
provide reviewed English/Hebrew/transliteration bridges; title vocabulary grows
automatically as titles are indexed. The request interpreter also recognizes
reviewed word families and dictionary-validated Hebrew prefixes, tolerates small
typos in recognized requests, and removes English/Hebrew question wrappers.
Unknown subjects retain literal, prefix, and bounded spelling retrieval. These
rules do not substitute for an unrestricted language model or embedding index.

## Research and choice

| Option                                                                                                                                                                      | Capabilities                                                                 | Fit for this project                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Apache Solr](https://solr.apache.org/guide/solr/latest/query-guide/standard-query-parser.html)                                                                             | Prefix wildcards, bounded Damerau-Levenshtein fuzzy queries, Boolean clauses | Selected for metadata. Live probes confirmed YUTorah's existing API accepts these queries against its full index.                  |
| [PostgreSQL pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) with [prefix full-text queries](https://www.postgresql.org/docs/current/textsearch-controls.html) | Indexed spelling candidates and prefix retrieval                             | Selected for transcripts. PostgreSQL documents a vocabulary-plus-trigram approach; the worker already uses PostgreSQL and pg_trgm. |
| [MiniSearch](https://lucaong.github.io/minisearch/)                                                                                                                         | In-process fuzzy/prefix search, ranking, suggestions                         | Suitable for a small local collection, but cannot retrieve unseen archive records without copying their metadata into memory.      |
| [Typesense](https://typesense.org/docs/29.0/api/search.html)                                                                                                                | Typo/prefix search, field weights, synonyms                                  | Good dedicated-search option; would require a second service plus a full metadata importer and ongoing synchronization.            |
| [Meilisearch](https://www.meilisearch.com/docs/capabilities/full_text_search/relevancy/typo_tolerance_settings)                                                             | Prefix edit-distance matching and configurable tolerance                     | Same additional hosting/import requirements.                                                                                       |

The decision uses the indexes that already own the searchable content. A fuzzy
matcher over the first page of keyword results cannot recover records that the
keyword endpoint never returned. Correcting only autocomplete would have the
same limitation. An LLM rewrite alone would also leave partial-word retrieval
unsolved and introduce latency, credentials, and nondeterministic guesses.

## Metadata retrieval

`packages/yutorah-core/src/search-matching.ts` owns normalization, aliases,
bounded edit distance, prefix matching, and literal query compilation.
`lib/search-matching.ts` exposes it to the website. Display strings are preserved.

Search normalizes case, diacritics, Hebrew vowels/cantillation, apostrophes, and
directional formatting marks. Adjacent transposed letters count as one edit.
Numeric tokens remain literal. Three-character input can match a four-character
word with one missing or transposed letter, without fuzzing between two short
words. Metadata expands these short corrections through known vocabulary rather
than an unrestricted fuzzy clause. Four-to-six-character words allow one edit
and longer words allow two. General prefixes start at three characters; directory suggestions
also allow two-character prefixes. The shared matcher also compares misspelled
words to a candidate's prefix, without charging for the untyped suffix.

The compiler joins subject groups with AND. A clause retains its literal word and
adds a prefix, a bounded fuzzy term, aliases, and up to four close vocabulary
completions from indexed titles and live teacher/topic/series names. For example, `schact` includes
`schact*`, `schact~1`, and the vocabulary completion `schachter`. Known subject
aliases use their group of spellings rather than unrelated fuzzy neighbors:
`eruv` should not expand to `erev`, nor `teshuva` to `yeshiva`.

For unknown five-to-twelve-letter tokens, generated single-character wildcards,
deletions, insertions, and transpositions also recover one-edit partial words
outside the live directory vocabulary. `donait`, for example, includes `donati*`
and `dona?it*`. These patterns have no leading wildcard, and their number shrinks
for longer multiword queries to keep request URLs bounded.
Four-letter transposed prefixes also work outside the directory vocabulary:
`doan` includes `dona*`. Other four-letter prefix-edit wildcards are omitted
because patterns such as `do?n*` expand to large unrelated “down…” candidate sets;
full-word fuzzy matching still retrieves their one-edit spelling candidates.

All user syntax is normalized into literal words before operators are generated.
Users cannot supply a field selector, raw Boolean operator, boost, or wildcard.
At most 32 distinct search words are accepted. Exact phrase and excluded-word
filters remain normalized whole-word constraints; quoted phrases bypass
conversational and alias interpretation.

Missing or extra spaces are repaired against unambiguous indexed title phrases,
alias/concept forms, and live teacher, topic, and series names. `dafyomi`, `roshhashana`,
`HershelSchachter`, and `te fillah` can recover their intended words. Quotes,
numbers, unknown names, and ambiguous readings stay literal. The same spacing
rules apply to suggestions, local matching, and smart transcripts. Ordinary
question wrappers such as “what should I know about” and “can you explain the
laws of” do not make those wrapper words mandatory subjects.

The natural parser recognizes common request/filter misspellings and discloses
corrections. A teacher mention selects an ID only when the best name is
unambiguous. First-name initials require an exact, unique full surname. A shortened surname shared by multiple teachers remains a metadata
search. Explicit teacher/filter choices take precedence. Series names may resolve
from a unique multiword partial match.

`complete-search.ts` fetches the entire expanded native candidate set using the
existing bounded/resumable passes. The cache fingerprint identifies the parsed
request and source filters with a new version. The compiled query, title spelling
vocabulary, repaired term, and disclosed corrections are snapshotted in the run;
learning more titles cannot change an in-progress expansion. Each candidate stores fuzzy relevance and whether
its title matches. Title scope, duration/date/language/media refinements, counts,
global ordering, and pagination all operate over the same D1 candidates.

If native retrieval returns zero candidates, the shared retrieval policy can
retry a three-to-eight-subject query with one secondary word omitted. Known
aliases, concept subjects, directory vocabulary, and numbers remain required;
generic modifiers such as “practical” can be omitted even when found in a
directory name. Every generated alternative still requires at least two subject
groups. The retry uses bounded AND/OR clauses, with a 1,800-character encoded-query ceiling,
rather than an unrestricted OR query. Quoted requests disable this recovery.
An upstream failure or zero results after duration/language/title refinements
does not trigger broader retrieval. Exact phrases, exclusions, and other filters
are still enforced on recovered candidates.

The selected query and recovery state are persisted with the run. Resuming or
changing refinements therefore uses the same candidates and matching policy.
The interface discloses “Broadened search” when recovered results are returned.
The first source page is reused for the scan rather than fetched twice.

The compiler measures the URL-encoded query, including multi-byte Hebrew text.
If a full expansion exceeds the budget it reduces optional spelling expansions,
then uses a compact or literal query while retaining every required subject.
This stays below the upstream server's observed query-string limit, consistent
with [IIS request limits](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/security/requestfiltering/requestlimits/).

Suggestions, visible highlights/excerpts, directory browsing, saved-library
search, and search within loaded results share the same matcher. Ranking lives in
`packages/yutorah-core/src/search-ranking.ts`: distinct subject coverage comes
first, then title coverage, whole-phrase exactness, field weights and match
confidence, and the smallest title window containing every requested subject.
Repeated mentions of one subject cannot outrank a result covering the complete
request. Direct matches score above prefixes, close spellings, and related forms.
The live directory is cached for one hour; word-match memoization is bounded to
20,000 entries. No client receives a full archive mirror.

These choices build on [Algolia's account of textual
relevance](https://www.algolia.com/blog/engineering/inside-the-algolia-enginepart-4-textual-relevance),
which describes coverage, proximity, attribute importance, and exactness, and
[Typesense's search documentation](https://typesense.org/docs/29.0/api/search.html),
which documents token dropping and split/join recovery. The implementation uses
YUTorah's existing index; it does not install either engine. Live probes verified
Boolean recovery through the [Solr standard query
parser](https://solr.apache.org/guide/solr/latest/query-guide/standard-query-parser.html).
The archive endpoint did not accept an eDisMax local-parameter request, so the
compiler generates the supported Boolean clauses itself.

An embedding retriever and model reranker, as described by [Sentence
Transformers](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html),
could add open-ended semantic matching. That needs an archive embedding index
and an inference provider that this project does not currently configure. The
current improvements instead strengthen retrieval and ranking over the content
available through the existing archive index.

## Transcript retrieval

The website and read-only HTTP search service default to `smart`. `phrase` and
`terms` retain their existing strict behavior; the store/CLI default remains
`phrase` for compatibility.

Migration `db/transcription/003_tolerant_search.sql` backfills a compact spelling
vocabulary from the existing indexed words and maintains it transactionally with
an insert/update trigger. Its trigram index retrieves up to 128 spelling
candidates per query word of at least three characters. The shared matcher validates them and retains up to
eight close words per token. Literal words, domain aliases, and valid candidates
become OR clauses; all requested tokens remain joined with AND.

An indexed tsvector over each segment window permits matches that cross an
adjacent segment boundary. A second constraint requires at least one requested
word in the timestamp's own segment. Only active transcripts are returned, with
literal matches ordered first. Numbers use exact clauses. The three-second
statement timeout and existing request/result limits remain in place.

Run the existing worker `migrate` command before restarting an upgraded
transcript service. The migration preserves SELECT access for an existing
`yutorah-search` role; custom read-only roles also need SELECT on the vocabulary
table. Fresh installations use the updated grants in the operations guide.
Metadata search requires the new D1 title-vocabulary migration described above;
its title ingestion does not require transcription-service settings.

## Validation

Use Node 22.13 or newer:

```sh
npm run test:search
node --test tests/learning.test.mjs
TEST_DATABASE_URL=postgresql://... npm run test:worker
npx tsc --noEmit
npm run worker:build
npm run lint
npm run build
# Against a running production preview:
npm run test:live
```

Tests cover submitted typo/partial retrieval, transpositions, ambiguity, aliases,
conversational filters, literal phrases/exclusions, safe query compilation,
ranking/highlights, last-page matches, cached refinements, distinct pagination,
spacing recovery, complete-subject/proximity ranking, empty-query recovery,
recovery resumption, literal overrides, learned title vocabulary without new
aliases, unique-title frequency, title edits, ambiguous phrase boundaries,
transactional archive backfill, and vocabulary changes during pagination.
PostgreSQL tests also verify transcript matches across segment boundaries. The PostgreSQL
suite must use a disposable test database; it isolates its fixtures in a new
schema and removes them afterward.

This provides tolerant retrieval and deterministic query interpretation. It does
not provide unrestricted semantic reasoning or generate religious answers.
Broad queries still require the existing archive scan to finish before counts
and global ordering become final.
