import {
  searchTerms,
  interpretSpacing,
  searchText,
  createTextMatcher,
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
  const matchers = terms.map((term) => createTextMatcher(term));
  const phrases = [...new Set([searchText(query), terms.join(' ')])].filter(
    Boolean,
  );
  return (document: SearchDocument) =>
    scoreDocument(document, matchers, phrases);
}
function scoreDocument(
  document: SearchDocument,
  matchers: ReturnType<typeof createTextMatcher>[],
  phrases: string[],
) {
  if (!matchers.length) return 0;
  const fields = [
    [prepareMatchText(document.title), 8],
    [prepareMatchText(document.topics.join(' ')), 5],
    [prepareMatchText(document.series), 3],
    [prepareMatchText(document.teacher), 3],
    [prepareMatchText(document.description), 1],
  ] as const;
  const evidence = matchers.map((matcher) => matcher.evidence(fields[0][0]));
  const titleScores = evidence.map((hits) =>
    Math.max(0, ...hits.map((hit) => hit.score)),
  );
  let covered = 0,
    reliable = 0,
    confidence = 0,
    weighted = 0;
  for (let i = 0; i < matchers.length; i++) {
    let best = titleScores[i];
    for (let j = 0; j < fields.length; j++) {
      const [text, weight] = fields[j];
      const score = j === 0 ? titleScores[i] : matchers[i].score(text);
      weighted += score * weight;
      best = Math.max(best, score);
    }
    if (best) covered++;
    if (best >= 0.8) reliable++;
    confidence += best;
  }
  const title = fields[0][0].normalized;
  const exactness = phrases.includes(title)
    ? 6000
    : phrases.some((phrase) => ` ${title} `.includes(` ${phrase} `))
      ? 4000
      : 0;
  // Find the smallest title window containing a match for every subject.
  const hits = evidence
    .flatMap((matches, group) => matches.map((hit) => ({ ...hit, group })))
    .sort((a, b) => a.start - b.start);
  const counts = Array(matchers.length).fill(0) as number[];
  // A monotonic deque tracks the furthest end without rescanning each window.
  const ends: number[] = [];
  let head = 0;
  let groups = 0,
    left = 0,
    window = Infinity;
  for (let right = 0; right < hits.length; right++) {
    while (ends.length > head && hits[ends.at(-1)!].end <= hits[right].end)
      ends.pop();
    ends.push(right);
    if (counts[hits[right].group]++ === 0) groups++;
    while (groups === matchers.length) {
      const end = hits[ends[head]].end;
      window = Math.min(window, end - hits[left].start);
      if (ends[head] === left) head++;
      if (--counts[hits[left++].group] === 0) groups--;
    }
  }
  const proximity = Number.isFinite(window)
    ? (500 * matchers.length) / Math.max(matchers.length, window)
    : 0;
  const density =
    (200 * titleScores.reduce((sum, score) => sum + score, 0)) /
    Math.max(matchers.length, fields[0][0].words.length);
  return (
    covered * 100_000_000 +
    reliable * 1_000_000 +
    titleScores.filter(Boolean).length * 10_000 +
    exactness +
    (weighted * 100 + confidence * 1000) / matchers.length +
    proximity +
    density
  );
}
