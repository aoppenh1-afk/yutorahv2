# Search corrections and original wording

October 10, 2026.

Searching `perek kirah` used to become `perek kinah`. The intent matcher knew
`kinah`, accepted a one-letter difference, and replaced the chapter name before
title retrieval. The client then replaced the text in the search box with the
interpreted keywords. There was no way to reject that interpretation.

## Research

Protecting valid words and offering alternatives solve different parts of this
problem. A dictionary reduces incorrect guesses, but unfamiliar transliterations
and titles can still be absent from it. A visible choice lets the reader recover
when the dictionary is wrong.

[Elasticsearch's suggesters](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/search-suggesters)
can restrict suggestions to missing terms, compare phrase confidence, and check
whether a proposed query matches documents. This supports using the archive's
vocabulary and verifying an alternative before displaying it.

[Algolia's typo settings](https://www.algolia.com/doc/guides/managing-results/optimize-search-results/typo-tolerance/in-depth/configuring-typo-tolerance)
include word-length limits and modes that prefer results with fewer typos. Merely
reducing edit distance would still confuse `kirah` and `kinah`, which differ by
one letter.

[Google's account of spelling in Search](https://blog.google/products-and-platforms/products/search/abcs-spelling-google-search/)
describes suggesting an alternative when confidence is lower, and disclosing an
automatic correction with a way to return to the original spelling. This is the
interaction adopted here. Confidence comes from the existing matcher and archive,
rather than a new language model or an English-only dictionary.

## Implemented behavior

- `kirah` and `kira` join the reviewed words protected from neighboring-subject
  corrections. This also protects the shared parser used by previews, suggestions,
  and smart transcript search before archive vocabulary is available.
- Metadata search looks up the exact input words in the title vocabulary before
  applying fuzzy subject, alias, or request-word corrections. The lookup accepts
  at most 32 distinct normalized words. Rare words do not compete with popular
  fuzzy candidates for this protection.
- Recognized aliases and ordinary request interpretation still work. Unrecognized
  typos retain the existing bounded recovery. Applied changes appear above the
  results with a **Search instead for** action.
- If an indexed spelling returns no source results, the original results remain.
  A unique nearby whole-word reading can appear as **Did you mean** after its
  concrete query returns source results under the same teacher, topic, and series
  filters. Equally plausible readings are withheld. Equivalent aliases count as
  one reading. A failed optional lookup leaves the original response intact.
- The search box keeps the submitted text. Choosing an alternative starts a new
  search with the resolved filters. **Search instead for** appears only after
  an applied correction and bypasses spelling, spacing, synonym, intent, and teacher-name
  interpretation. It sends normalized literal words without fuzzy or prefix
  operators. Quotes still enforce an exact phrase. The mode survives sharing,
  reloads, saved searches, refinements, and pagination through `literal=1`.
  Resolved filters stay explicit, so removing a teacher or duration does not
  reapply it from the unchanged query text.
- Dictionary protection and suggestions are stored with each search run. Learning
  new titles cannot change a search while it is being scanned or resumed. The
  search fingerprint version is now 10, and literal runs use separate caches.

These changes use the existing title table and require no database migration.
Exact-word protection depends on the archive vocabulary that has been indexed.
The original-wording action remains available for terms outside that vocabulary.

## Validation

Regression tests cover `perek kirah`, exact archive spellings, genuine typo
recovery, literal retrieval, preserved filters, verified suggestions, ambiguous
alternatives, optional lookup failure, and resume stability after learning a new
word. All 102 search tests, TypeScript, lint, and the production build passed.
Browser checks cover desktop and mobile correction choices, filter retention,
removing a duration written in the query, and horizontal overflow. Those checks
used isolated search fixtures. The local endpoint initially returned HTTP 502
because six existing database migrations had not been applied. After applying
them locally, the real `perek kirah` request returned HTTP 200 with 59 results
and preserved the submitted wording. The backend tests exercise the real search
pipeline against SQLite with controlled source responses.
