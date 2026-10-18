import type { Directory } from './yutorah';
import {
  searchText,
  searchTerms,
  textMatchScore,
  teacherWordMatch,
  matchingSpans,
  interpretSpacing,
  prepareMatchText,
  prepareSpacingVocabulary,
  searchVocabulary,
} from './search-matching';
import { naturalSearch } from './natural-search';
import { createTitleScorer } from '../packages/yutorah-core/src/search-ranking.js';
export { searchText } from './search-matching';

export type SearchSuggestion = {
  id: number;
  kind: 'teacher' | 'topic' | 'series' | 'collection' | 'venue';
  name: string;
  count: number;
  context: string;
};

export type ShiurSuggestion = {
  id: number;
  kind: 'shiur';
  name: string;
  context: string;
};

export type LibrarySuggestion = SearchSuggestion | ShiurSuggestion;

function createSuggestionScorer(
  query: string,
  spacing: ReturnType<typeof prepareSpacingVocabulary>,
) {
  query = interpretSpacing(query, spacing).term;
  const score = createTitleScorer(query);
  const teacherScore = createTitleScorer(
    query.replace(/^(rabbi|rabi|rabby|rav|r)\s+/i, ''),
  );
  return (suggestion: LibrarySuggestion) =>
    suggestion.kind === 'teacher'
      ? teacherScore(suggestion.name.replace(/^(rabbi|rav|r)\s+/i, ''))
      : score(suggestion.name);
}

export function combineSearchSuggestions(
  directory: LibrarySuggestion[],
  remote: LibrarySuggestion[],
  query: string,
  limit = 8,
): LibrarySuggestion[] {
  const score = createSuggestionScorer(
    query,
    prepareSpacingVocabulary(
      [...directory, ...remote].map((s) =>
        s.kind === 'teacher'
          ? s.name.replace(/^(rabbi|rav|r)\s+/i, '')
          : s.name,
      ),
    ),
  );
  return [
    ...new Map(
      [...directory, ...remote].map((s) => [`${s.kind}-${s.id}`, s]),
    ).values(),
  ]
    .map((suggestion) => ({
      suggestion,
      score: score(suggestion),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.suggestion.name.length - b.suggestion.name.length ||
        a.suggestion.name.localeCompare(b.suggestion.name) ||
        b.suggestion.id - a.suggestion.id,
    )
    .slice(0, limit)
    .map(({ suggestion }) => suggestion);
}

const teacherTitle = /^(?:rabbi|rabi|rabby|rav|r)$/;

/** Resolve only an unambiguous mention, keeping the actual span for removal. */
export function teacherMention(term: string, directory: Directory) {
  const tokens = [...term.matchAll(/[\p{L}\p{M}\p{N}'’״׳]+/gu)].map(
    (match) => ({
      word: searchText(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    }),
  );
  const hits: {
    teacher: Directory['teachers'][number];
    start: number;
    end: number;
    score: number;
  }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].word || teacherTitle.test(tokens[i].word)) continue;
    let start = i;
    if (i > 0 && teacherTitle.test(tokens[i - 1].word)) start--;
    if (start > 0 && tokens[start - 1].word === 'by') start--;
    const explicit = start !== i;
    for (const { teacher, fullName, surname } of directorySearchIndex(directory)
      .teachers) {
      for (const name of [fullName, ...(explicit ? [surname] : [])]) {
        if (!name.length || i + name.length > tokens.length) continue;
        if (!explicit && name.length < 2) continue;
        const fuzzy = explicit || (i === 0 && name.length === tokens.length);
        const scores: number[] = [];
        const initial =
          name === fullName && name.length >= 2 && tokens[i].word.length === 1;
        if (
          initial &&
          !name.slice(1).every((word, j) => tokens[i + j + 1].word === word)
        )
          continue;
        for (let j = 0; j < name.length; j++) {
          const score =
            initial &&
            j === 0 &&
            (explicit || fuzzy) &&
            name[0].startsWith(tokens[i].word)
              ? 0.9
              : fuzzy
                ? teacherWordMatch(tokens[i + j].word, name[j])
                : Number(tokens[i + j].word === name[j]);
          if (!score) break;
          scores.push(score);
        }
        if (scores.length !== name.length) continue;
        // A fuzzy name without a title needs to occupy the whole query. Exact
        // full names can also occur naturally alongside a subject.
        if (
          !explicit &&
          scores.some((score) => score < 1) &&
          (i !== 0 || name.length !== tokens.length)
        )
          continue;
        hits.push({
          teacher,
          start: tokens[start].start,
          end: tokens[i + name.length - 1].end,
          score:
            scores.reduce((sum, score) => sum + score, 0) +
            (name === fullName ? 2 : 0),
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];
  if (
    !best ||
    hits.some(
      (hit) =>
        hit.teacher.id !== best.teacher.id &&
        Math.abs(hit.score - best.score) < 0.01,
    )
  )
    return null;
  return best;
}

const suggestionIndexes = new WeakMap<
  Directory,
  ReturnType<typeof buildSuggestionIndex>
>();
type SuggestionDirectory = Directory & {
  collections?: { id: number; name: string; count: number }[];
  venues?: { id: number; name: string; count: number }[];
};
function buildSuggestionIndex(directory: SuggestionDirectory) {
  const names = [
    ...directory.teachers.map((t) => `${t.firstName} ${t.lastName}`),
    ...directory.topics.map((t) => t.name),
    ...directory.series.map((t) => t.name),
    ...(directory.collections || []).map((t) => t.name),
    ...(directory.venues || []).map((t) => t.name),
  ];
  const entries: SearchSuggestion[] = [
    ...directory.teachers.map((t) => ({
      id: t.id,
      kind: 'teacher' as const,
      name: t.name,
      count: t.count,
      context: 'Teacher',
    })),
    ...directory.topics.map((t) => ({
      id: t.id,
      kind: 'topic' as const,
      name: t.name,
      count: t.count,
      context: t.group,
    })),
    ...directory.series.map((s) => ({
      id: s.id,
      kind: 'series' as const,
      name: s.name,
      count: s.count,
      context: 'Series',
    })),
    ...(directory.collections || []).map((s) => ({
      id: s.id,
      kind: 'collection' as const,
      name: s.name,
      count: s.count,
      context: 'Collection',
    })),
    ...(directory.venues || []).map((s) => ({
      id: s.id,
      kind: 'venue' as const,
      name: s.name,
      count: s.count,
      context: 'Venue',
    })),
  ];
  return {
    entries: entries.map((entry) => {
      const normalized = searchText(entry.name);
      const name =
        entry.kind === 'teacher'
          ? normalized.replace(/^(rabbi|rav|r)\s+/, '')
          : normalized;
      return {
        entry,
        name,
        words: name.split(' '),
        prepared: prepareMatchText(name),
      };
    }),
    spacing: prepareSpacingVocabulary(names),
    vocabulary: searchVocabulary(names),
    seriesById: new Map(directory.series.map((series) => [series.id, series])),
    topicsById: new Map(directory.topics.map((topic) => [topic.id, topic])),
    teachers: directory.teachers.map((teacher) => ({
      teacher,
      fullName: searchText(`${teacher.firstName} ${teacher.lastName}`)
        .split(' ')
        .filter(Boolean),
      surname: searchText(teacher.lastName).split(' ').filter(Boolean),
    })),
  };
}

/** One immutable directory index is shared by parsing, suggestions and scans. */
export function directorySearchIndex(directory: SuggestionDirectory) {
  let index = suggestionIndexes.get(directory);
  if (!index) {
    index = buildSuggestionIndex(directory);
    suggestionIndexes.set(directory, index);
  }
  return index;
}

export function suggestSearch(
  query: string,
  directory: SuggestionDirectory | null,
  limit = 8,
): SearchSuggestion[] {
  if (!directory) return [];
  const index = directorySearchIndex(directory);
  // Keep literal names even when they contain request words such as "English"
  // or "Shiurim". Conversational cleanup is an additional retrieval path.
  const terms = [
    ...new Set(
      [query, naturalSearch(query, undefined, index.vocabulary).term].map(
        (value) => searchText(interpretSpacing(value, index.spacing).term),
      ),
    ),
  ]
    .filter((term) => term.length >= 2)
    .map((term) => ({
      term,
      tokens: searchTerms(term),
      teacherTerm: term.replace(/^(rabbi|rabi|rabby|rav|r)\s+/, ''),
    }));
  if (!terms.length) return [];
  const score = createSuggestionScorer(query, index.spacing);
  return index.entries
    .map(({ entry, name, words, prepared }) => {
      const matches = terms.some(({ term, tokens, teacherTerm }) => {
        if (entry.kind === 'teacher') {
          term = teacherTerm;
          tokens = searchTerms(term);
        }
        if (name.includes(term)) return true;
        if (!tokens.length) return false;
        const initial =
          entry.kind === 'teacher' &&
          tokens.length === words.length &&
          tokens[0].length === 1 &&
          tokens.slice(1).every((word, i) => word === words[i + 1]);
        return tokens.every((token, index) => {
          const match =
            initial && index === 0 && words[0].startsWith(token)
              ? 0.9
              : entry.kind === 'teacher'
                ? words.reduce(
                    (best, word) =>
                      Math.max(best, teacherWordMatch(token, word, 2)),
                    0,
                  )
                : textMatchScore(prepared, token, 2);
          return match > 0;
        });
      });
      return { entry, score: matches ? score(entry) : 0 };
    })
    .filter((hit) => hit.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.name.length - b.entry.name.length ||
        a.entry.name.localeCompare(b.entry.name) ||
        b.entry.id - a.entry.id,
    )
    .slice(0, limit)
    .map((hit) => hit.entry);
}

const collectionDirectories = new WeakMap<
  NonNullable<SuggestionDirectory['collections']>,
  SuggestionDirectory
>();
export function suggestCollections(
  query: string,
  collections: NonNullable<SuggestionDirectory['collections']>,
) {
  let directory = collectionDirectories.get(collections);
  if (!directory) {
    directory = {
      teachers: [],
      topics: [],
      series: [],
      groups: [],
      collections,
    };
    collectionDirectories.set(collections, directory);
  }
  return suggestSearch(query, directory);
}

export function highlightParts(
  text: string,
  query: string,
): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let end = 0;
  for (const span of matchingSpans(text, query)) {
    if (span.start > end)
      parts.push({ text: text.slice(end, span.start), match: false });
    parts.push({ text: text.slice(span.start, span.end), match: true });
    end = span.end;
  }
  if (end < text.length || !parts.length)
    parts.push({ text: text.slice(end), match: false });
  return parts;
}

export {
  relevanceScore,
  createRelevanceScorer,
} from '../packages/yutorah-core/src/search-ranking.js';

export function matchExcerpt(
  description: string,
  query: string,
  limit = 230,
): string {
  if (description.length <= limit) return description;
  const parts = highlightParts(description, query);
  let first = 0;
  for (const part of parts) {
    if (part.match) break;
    first += part.text.length;
  }
  if (first === description.length) first = 0;
  let start = Math.max(0, first - 65);
  if (start > 0) {
    const boundary = description.indexOf(' ', start);
    if (boundary >= 0 && boundary < first) start = boundary + 1;
  }
  const end = Math.min(description.length, start + limit);
  return (
    (start ? '…' : '') +
    description.slice(start, end).trim() +
    (end < description.length ? '…' : '')
  );
}
