/** Display text is preserved separately. This normalization is for search only. */
import {
  interpretAliases,
  interpretSpacing,
  interpretSearchRequest,
  relatedSearchTerms,
  searchAliases,
  searchText,
  searchTerms,
  searchVocabulary,
  searchWords,
  wordMatch,
} from './search-matching.js';
export function normalizeTranscriptSearch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/["'\u05f3\u05f4\u2018\u2019\u201c\u201d]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
export const searchNormalizationVersion = '1';
const aliases = [
  ['חזרה', 'chazara', 'chazarah'],
  ['תוס׳', 'תוספות', 'tosfos', 'tosafot', 'tosafos'],
  ['רש״י', 'rashi'],
  ['מיגו', 'migo'],
].map((group) => group.map(normalizeTranscriptSearch));
export function searchVariants(query: string, expandAliases = true): string[] {
  const normalized = normalizeTranscriptSearch(query);
  if (!normalized || query.length > 200 || normalized.split(' ').length > 16)
    throw new Error('Invalid transcript query');
  if (!expandAliases) return [normalized];
  let variants = [''];
  for (const word of normalized.split(' ')) {
    const alternatives = aliases.find((group) => group.includes(word)) ?? [
      word,
    ];
    variants = variants
      .flatMap((prefix) => alternatives.map((w) => `${prefix} ${w}`.trim()))
      .slice(0, 32);
  }
  return [...new Set([normalized, ...variants])];
}
export function timestampLink(shiurId: string, startMs: number): string {
  return `/?shiur=${encodeURIComponent(shiurId)}&t=${Math.floor(startMs / 1000)}`;
}

/** Prefix FTS clauses, with spelling candidates checked by the shared matcher. */
export function transcriptSearchClauses(
  query: string,
  candidates: Map<string, string[]> = new Map(),
  expandAliases = true,
) {
  // Apply the same size/word validation as exact transcript search.
  const original = searchVariants(query, false)[0];
  const spacing = expandAliases
    ? interpretSpacing(original)
    : { term: original, labels: [] };
  const intent = expandAliases
    ? interpretSearchRequest(spacing.term)
    : { term: spacing.term, labels: [] };
  // Common spoken phrases can consist entirely of request words.
  const normalized = intent.term || spacing.term;
  let spellingExpanded = spacing.labels.length > 0;
  let aliasesExpanded = intent.labels.length > 0;
  const anchors = new Set<string>();
  const compileWord = (token: string) => {
    const words = new Set([token]);
    if (expandAliases) {
      const interpreted = interpretAliases(token);
      for (const alias of searchAliases(interpreted.term)) words.add(alias);
      for (const form of searchVocabulary())
        if (wordMatch(searchText(token), form) > 0)
          for (const alias of searchAliases(form)) words.add(alias);
      aliasesExpanded ||= words.size > 1;
      spellingExpanded ||=
        interpreted.labels.length > 0 &&
        !searchAliases(token).includes(searchText(interpreted.term));
    }
    const matched = (candidates.get(token) ?? [])
      .map((word) => ({
        word,
        score: wordMatch(searchText(token), searchText(word)),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word))
      .slice(0, 8);
    for (const { word, score } of matched) {
      words.add(word);
      spellingExpanded ||= score < 0.85;
    }
    return (
      '(' +
      [...words]
        .map((word) => {
          // Normalized words contain letters/numbers only; single quotes additionally
          // make the tsquery literal contract explicit. Numbers never use prefixes.
          const literal =
            "'" + normalizeTranscriptSearch(word).replaceAll("'", "''") + "'";
          return (
            literal + (word.length >= 3 && !/\p{N}/u.test(word) ? ':*' : '')
          );
        })
        .join(' | ') +
      ')'
    );
  };
  const clauses = searchTerms(normalized).map((term) => {
    const forms = expandAliases ? relatedSearchTerms(term) : [term];
    aliasesExpanded ||= forms.length > 1;
    const alternatives = forms.map((form) => {
      const words = searchWords(form).map(compileWord);
      for (const word of words) anchors.add(word);
      return words.length === 1 ? words[0] : '(' + words.join(' & ') + ')';
    });
    return alternatives.length === 1
      ? alternatives[0]
      : '(' + alternatives.join(' | ') + ')';
  });
  return {
    all: clauses.join(' & '),
    any: [...anchors].join(' | '),
    spellingExpanded,
    aliasesExpanded,
  };
}
