import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
const compiled = await build({
  entryPoints: [
    'lib/source-highlights.ts',
    'packages/yutorah-core/src/search-matching.ts',
    'lib/library.ts',
  ],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  outdir: 'unused',
});
const [highlights, matching, library] = await Promise.all(
  compiled.outputFiles.map(
    (file) =>
      import(
        'data:text/javascript;base64,' +
          Buffer.from(file.text).toString('base64')
      ),
  ),
);
const time = (operation) => {
  const start = performance.now();
  const value = operation();
  return { ms: +(performance.now() - start).toFixed(2), value };
};
const sources = Array.from({ length: 500 }, (_, index) => ({
  ref: `Genesis ${index + 1}:1`,
  url: 'https://example.test/' + index,
  occurrences: [
    {
      spans: [
        { segmentIndex: index * 10, startChar: 2, endChar: 12 },
        { segmentIndex: index * 10 + 1, startChar: 0, endChar: 4 },
      ],
    },
  ],
}));
const legacyHighlights = (sources, segmentIndex) => {
  const spans = sources
    .flatMap((source) =>
      source.occurrences.flatMap((o) =>
        o.spans.map((span) => ({ ...span, ref: source.ref, url: source.url })),
      ),
    )
    .filter((span) => span.segmentIndex === segmentIndex)
    .sort((a, b) => a.startChar - b.startChar || b.endChar - a.endChar);
  let end = 0;
  return spans.filter((span) => {
    if (span.startChar < end || span.endChar <= span.startChar) return false;
    end = span.endChar;
    return true;
  });
};
const old = time(() =>
  Array.from({ length: 5000 }, (_, i) => legacyHighlights(sources, i)),
);
const indexed = time(() => {
  const map = highlights.indexSourceHighlights(sources);
  return Array.from({ length: 5000 }, (_, i) => map.get(i) ?? []);
});
assert.deepEqual(indexed.value, old.value);
const documents = Array.from(
  { length: 1000 },
  (_, i) =>
    `Hilchos Shabbos shiur ${i} Rabbi Example Quantum Halacha שלומ בית ` +
    'Practical cases with distinct dates and varying series descriptions. '.repeat(
      (i % 6) + 1,
    ),
);
const prepared = time(() => documents.map(matching.prepareSearchText));
const queries = [
  'shabos',
  'quantmu halacha',
  '100',
  'שלום',
  '"practical cases"',
  'quantumhalacha',
];
const raw = time(() =>
  queries.map((query) =>
    documents.map((document) => matching.matchQuery(document, query)),
  ),
);
const reused = time(() =>
  queries.map((query) => {
    const matcher = matching.createQueryMatcher(query);
    return prepared.value.map(matcher);
  }),
);
assert.deepEqual(reused.value, raw.value);
const recording = (id) => ({
  id,
  title: 'A realistic recording title with a teacher and series',
  teacher: 'Rabbi Fixture',
  topics: ['Shabbat'],
  duration: 3600,
  description: 'A representative description. '.repeat(15),
});
const saved = Array.from({ length: 1000 }, (_, i) => recording(i + 1));
const snapshot = {
  saved,
  queue: saved.slice(0, 100),
  history: saved
    .slice(0, 200)
    .map((shiur) => ({ shiur, seconds: 40, duration: 3600 })),
  playlists: Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    name: `Playlist ${i}`,
    items: saved.slice(i * 100, (i + 1) * 100),
  })),
  last: saved[0],
};
const redundant = time(() => JSON.stringify(snapshot));
const normalized = time(() => library.serializeLibrary(snapshot));
console.log(
  JSON.stringify(
    {
      fixture: {
        segments: 5000,
        citationSpans: 1000,
        documents: 1000,
        queries: queries.length,
        saved: 1000,
      },
      highlightsMs: { repeatedScan: old.ms, indexed: indexed.ms },
      matchingMs: {
        prepareOnce: prepared.ms,
        repeatedPreparation: raw.ms,
        preparedQueries: reused.ms,
      },
      library: {
        redundantBytes: Buffer.byteLength(redundant.value),
        normalizedBytes: Buffer.byteLength(normalized.value),
        redundantMs: redundant.ms,
        normalizedMs: normalized.ms,
      },
    },
    null,
    2,
  ),
);
