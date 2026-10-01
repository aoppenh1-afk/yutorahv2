# Typo and partial-word search

Implemented September 30, 2026. No new hosted search service, API account, or
model credentials are required.

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
Numeric tokens remain literal. Words shorter than four characters do not receive
typo correction; four-to-six-character words allow one edit and longer words
allow two. General prefixes start at three characters; directory suggestions
also allow two-character prefixes. The shared matcher also compares misspelled
words to a candidate's prefix, without charging for the untyped suffix.

The compiler joins subject words with AND. A clause retains its literal word and
adds a prefix, a bounded fuzzy term, aliases, and up to four close vocabulary
completions from live teacher/topic/series names. For example, `schact` includes
`schact*`, `schact~1`, and the vocabulary completion `schachter`. Known subject
aliases use their group of spellings rather than unrelated fuzzy neighbors:
`eruv` should not expand to `erev`, nor `teshuva` to `yeshiva`.

For unknown five-to-twelve-letter tokens, generated single-character wildcards,
deletions, insertions, and transpositions also recover one-edit partial words
outside the live directory vocabulary. `donait`, for example, includes `donati*`
and `dona?it*`. These patterns have no leading wildcard, and their number shrinks
for longer multiword queries to keep request URLs bounded.

All user syntax is normalized into literal words before operators are generated.
Users cannot supply a field selector, raw Boolean operator, boost, or wildcard.
At most 32 distinct search words are accepted. Exact phrase and excluded-word
filters remain normalized whole-word constraints; quoted phrases bypass
conversational and alias interpretation.

The natural parser recognizes common request/filter misspellings and discloses
corrections. A teacher mention selects an ID only when the best name is
unambiguous. A shortened surname shared by multiple teachers remains a metadata
search. Explicit teacher/filter choices take precedence. Series names may resolve
from a unique multiword partial match.

`complete-search.ts` fetches the entire expanded native candidate set using the
existing bounded/resumable passes. The cache fingerprint includes the compiled
query and a new version, preventing reuse of old keyword-only runs or resuming
with a different expansion. Each candidate stores fuzzy relevance and whether
its title matches. Title scope, duration/date/language/media refinements, counts,
global ordering, and pagination all operate over the same D1 candidates.

Suggestions, visible highlights/excerpts, directory browsing, saved-library
search, and search within loaded results share the same matcher. Exact title
matches rank above prefixes, close spellings, and incidental description hits.
The live directory is cached for one hour; word-match memoization is bounded to
20,000 entries. No client receives a full archive mirror.

## Transcript retrieval

The website and read-only HTTP search service default to `smart`. `phrase` and
`terms` retain their existing strict behavior; the store/CLI default remains
`phrase` for compatibility.

Migration `db/transcription/003_tolerant_search.sql` backfills a compact spelling
vocabulary from the existing indexed words and maintains it transactionally with
an insert/update trigger. Its trigram index retrieves up to 128 spelling
candidates per query word. The shared matcher validates them and retains up to
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
Metadata search requires no new D1 migration or transcription-service settings.

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
and PostgreSQL transcript matches across segment boundaries. The PostgreSQL
suite must use a disposable test database; it isolates its fixtures in a new
schema and removes them afterward.

This provides tolerant retrieval and deterministic query interpretation. It does
not provide unrestricted semantic reasoning or generate religious answers.
Broad queries still require the existing archive scan to finish before counts
and global ordering become final.
