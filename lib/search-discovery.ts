import type { Directory } from './yutorah';

export type SearchSuggestion = {
  id: number;
  kind: 'teacher' | 'topic' | 'series';
  name: string;
  count: number;
  context: string;
};

// Keep the same normalization in directory search and typed suggestions.
export function searchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u0591-\u05c7]/g, '')
    .toLowerCase()
    .replace(/['’"״׳]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length];
}

export function suggestSearch(
  query: string,
  directory: Directory | null,
): SearchSuggestion[] {
  const term = searchText(query).replace(/^(rabbi|rav|r)\s+/, '');
  if (!directory || term.length < 2) return [];
  const tokens = term.split(' ');
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
      if (
        !score &&
        tokens.every((token) => words.some((word) => word.startsWith(token)))
      )
        score = 55;
      if (
        !score &&
        tokens.every((token) =>
          words.some(
            (word) =>
              token.length >= 4 &&
              distance(token, word) <= (token.length >= 7 ? 2 : 1),
          ),
        )
      )
        score = 25;
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
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 12);
  if (!words.length) return [{ text, match: false }];
  const expression = words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(${expression})`, 'ig');
  return text
    .split(re)
    .filter(Boolean)
    .map((part) => ({
      text: part,
      match: words.some((w) => w.toLowerCase() === part.toLowerCase()),
    }));
}

export function relevanceScore(
  shiur: {
    title: string;
    topics: string[];
    series: string;
    description: string;
    teacher: string;
  },
  query: string,
): number {
  const term = searchText(query);
  if (!term) return 0;
  const title = searchText(shiur.title);
  const topics = searchText(shiur.topics.join(' '));
  const series = searchText(shiur.series);
  const description = searchText(shiur.description);
  const teacher = searchText(shiur.teacher);
  const tokens = term.split(' ').filter((t) => t.length > 1);
  let score = title === term ? 100 : title.includes(term) ? 60 : 0;
  if (topics.includes(term)) score += 35;
  if (series.includes(term)) score += 25;
  for (const token of tokens) {
    if (title.includes(token)) score += 8;
    if (topics.includes(token)) score += 5;
    if (series.includes(token) || teacher.includes(token)) score += 3;
    if (description.includes(token)) score += 1;
  }
  return score;
}

export function matchExcerpt(
  description: string,
  query: string,
  limit = 230,
): string {
  if (description.length <= limit) return description;
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const first =
    tokens
      .map((t) => description.toLowerCase().indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
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
