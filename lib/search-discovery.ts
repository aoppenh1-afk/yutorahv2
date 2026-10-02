import type { Directory } from './yutorah';
import {
  searchText,
  searchTerms,
  textMatchScore,
  wordMatch,
  matchingSpans,
  interpretSpacing,
} from './search-matching';
import { naturalSearch } from './natural-search';
export { searchText } from './search-matching';

export type SearchSuggestion = {
  id: number;
  kind: 'teacher' | 'topic' | 'series';
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

export function combineSearchSuggestions(
  directory: SearchSuggestion[],
  shiurim: ShiurSuggestion[],
): (SearchSuggestion | ShiurSuggestion)[] {
  // Directory matches require the whole query. Reserve space for five titles.
  return [
    ...directory.slice(0, shiurim.length ? 3 : 8),
    ...shiurim.slice(0, 5),
  ];
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
    for (const teacher of directory.teachers) {
      const fullName = searchText(`${teacher.firstName} ${teacher.lastName}`)
        .split(' ')
        .filter(Boolean);
      const surname = searchText(teacher.lastName).split(' ').filter(Boolean);
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
                ? wordMatch(tokens[i + j].word, name[j])
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

export function suggestSearch(
  query: string,
  directory: Directory | null,
): SearchSuggestion[] {
  if (!directory) return [];
  const spacing = interpretSpacing(naturalSearch(query).term, [
    ...directory.teachers.map(
      (teacher) => `${teacher.firstName} ${teacher.lastName}`,
    ),
    ...directory.topics.map((topic) => topic.name),
    ...directory.series.map((series) => series.name),
  ]);
  const term = searchText(spacing.term).replace(
    /^(rabbi|rabi|rabby|rav|r)\s+/,
    '',
  );
  if (term.length < 2) return [];
  const tokens = searchTerms(term);
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
  ];
  return entries
    .map((entry) => {
      const name = searchText(entry.name).replace(/^(rabbi|rav|r)\s+/, '');
      const words = name.split(' ');
      let score =
        name === term
          ? 100
          : name.startsWith(term)
            ? 80
            : name.includes(term)
              ? 65
              : 0;
      if (!score) {
        let total = 0;
        const initial =
          entry.kind === 'teacher' &&
          tokens.length === words.length &&
          tokens[0].length === 1 &&
          tokens.slice(1).every((word, i) => word === words[i + 1]);
        for (const [index, token] of tokens.entries()) {
          const match =
            initial && index === 0 && words[0].startsWith(token)
              ? 0.9
              : entry.kind === 'teacher'
                ? words.reduce(
                    (best, word) => Math.max(best, wordMatch(token, word, 2)),
                    0,
                  )
                : textMatchScore(name, token, 2);
          if (!match) {
            total = 0;
            break;
          }
          total += match;
        }
        if (total) score = (50 * total) / tokens.length;
      }
      return { entry, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.count - a.entry.count)
    .slice(0, 8)
    .map((hit) => hit.entry);
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

export { relevanceScore } from '../packages/yutorah-core/src/search-ranking.js';

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
