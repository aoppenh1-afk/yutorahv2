import {
  searchTerms,
  interpretSpacing,
  searchText,
  textMatchEvidence,
  textMatchScore,
  prepareMatchText,
} from './search-matching.js';

export type SearchDocument = {
  title: string;
  topics: string[];
  series: string;
  description: string;
  teacher: string;
};

/** Subject coverage dominates field placement, then confidence and proximity.
 * Repeating one subject cannot outrank a document answering the whole request.
 */
export function relevanceScore(
  document: SearchDocument,
  query: string,
): number {
  return createRelevanceScorer(query)(document);
}
export function createRelevanceScorer(query: string) {
  const terms = [...new Set(searchTerms(interpretSpacing(query).term))].slice(
    0,
    32,
  );
  return (document: SearchDocument) => scoreDocument(document, terms);
}
function scoreDocument(document: SearchDocument, terms: string[]) {
  if (!terms.length) return 0;
  const fields = [
    [prepareMatchText(document.title), 8],
    [prepareMatchText(document.topics.join(' ')), 5],
    [prepareMatchText(document.series), 3],
    [prepareMatchText(document.teacher), 3],
    [prepareMatchText(document.description), 1],
  ] as const;
  const evidence = terms.map((term) => textMatchEvidence(fields[0][0], term));
  const titleScores = evidence.map((hits) =>
    Math.max(0, ...hits.map((hit) => hit.score)),
  );
  let covered = 0,
    confidence = 0,
    weighted = 0;
  for (let i = 0; i < terms.length; i++) {
    let best = titleScores[i];
    for (let j = 0; j < fields.length; j++) {
      const [text, weight] = fields[j];
      const score = j === 0 ? titleScores[i] : textMatchScore(text, terms[i]);
      weighted += score * weight;
      best = Math.max(best, score);
    }
    if (best) covered++;
    confidence += best;
  }
  const title = searchText(document.title);
  const phrase = terms.join(' ');
  const exactness =
    title === phrase ? 6000 : ` ${title} `.includes(` ${phrase} `) ? 4000 : 0;
  // Find the smallest title window containing a match for every subject.
  const hits = evidence
    .flatMap((matches, group) => matches.map((hit) => ({ ...hit, group })))
    .sort((a, b) => a.start - b.start);
  const counts = Array(terms.length).fill(0) as number[];
  let groups = 0,
    left = 0,
    window = Infinity;
  for (let right = 0; right < hits.length; right++) {
    if (counts[hits[right].group]++ === 0) groups++;
    while (groups === terms.length) {
      const end = Math.max(
        ...hits.slice(left, right + 1).map((hit) => hit.end),
      );
      window = Math.min(window, end - hits[left].start);
      if (--counts[hits[left++].group] === 0) groups--;
    }
  }
  const proximity = Number.isFinite(window)
    ? (500 * terms.length) / Math.max(terms.length, window)
    : 0;
  return (
    covered * 1_000_000 +
    titleScores.filter(Boolean).length * 10_000 +
    exactness +
    (weighted * 100 + confidence * 1000) / terms.length +
    proximity
  );
}
