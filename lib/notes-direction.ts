import type { Root, RootContent, PhrasingContent } from 'mdast';

const LRM = '\u200e';
const RLM = '\u200f';
const isHebrew = (character: string) =>
  /[\u0590-\u05ff\ufb1d-\ufb4f]/u.test(character);
const isSpace = (character: string) => /\s/u.test(character);
const isLetter = (character: string) => /\p{L}/u.test(character);
const punctuation = ',;:.!?…–-';
type InlineRun = { text: string; bold?: boolean };
type Insertion = { offset: number; text: string; opening?: boolean };

export function stripNotesDirectionControls(text: string): string {
  return text.replace(/[\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/gu, '');
}

function hebrewSegments(
  text: string,
  start: number,
  end: number,
  isLabel: boolean,
) {
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  // The label separator flows with the outline; a daf's amud marker stays Hebrew.
  if (
    isLabel &&
    text[end - 1] === ':' &&
    !/דף\s+[א-ת״׳]+:$/u.test(text.slice(start, end))
  )
    end--;
  if (end <= start) return [];
  const hebrewOnly = (from: number, to: number) => {
    const characters = Array.from(text.slice(from, to));
    return (
      characters.some(isHebrew) &&
      !characters.some((c) => isLetter(c) && !isHebrew(c))
    );
  };
  if (!/\p{Nd}/u.test(text[start]) && hebrewOnly(start, end))
    return [{ start, end }];

  const pairs: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
    '"': '"',
    '“': '”',
  };
  function pairedEnd(opening: number) {
    const closing = pairs[text[opening]];
    if (
      !closing ||
      (text[opening] === '"' && opening > start && isHebrew(text[opening - 1]))
    )
      return;
    let depth = 1;
    for (let cursor = opening + 1; cursor < end; cursor++) {
      if (text[cursor] === closing) {
        if (
          closing === '"' &&
          cursor > opening + 1 &&
          cursor + 1 < end &&
          isHebrew(text[cursor - 1]) &&
          isHebrew(text[cursor + 1])
        )
          continue;
        if (--depth === 0) return cursor + 1;
      } else if (text[cursor] === text[opening]) depth++;
    }
  }
  const citations = Array.from(
    text
      .slice(start, end)
      .matchAll(/דף[ \t]+[א-ת״׳]+[.:]?(?:[-–][א-ת״׳]+[.:]?)?/gu),
    (match) => ({
      start: start + match.index,
      end: start + match.index + match[0].length,
    }),
  );
  const segments: { start: number; end: number }[] = [];
  let cursor = start;
  while (cursor < end) {
    const close = pairedEnd(cursor);
    if (close && hebrewOnly(cursor + 1, close - 1)) {
      segments.push({ start: cursor, end: close });
      cursor = close;
      continue;
    }
    if (!isHebrew(text[cursor])) {
      cursor++;
      continue;
    }
    const runStart = cursor;
    let runEnd = ++cursor;
    while (cursor < end) {
      const character = text[cursor];
      if (isHebrew(character)) runEnd = cursor + 1;
      else if (isSpace(character)) {
        // Whitespace belongs to the phrase only when another Hebrew word follows.
        if (character === '\n' || character === '\r') break;
      } else if (
        (character === '"' || character === "'") &&
        cursor + 1 < end &&
        isHebrew(text[cursor - 1]) &&
        isHebrew(text[cursor + 1])
      )
        runEnd = cursor + 1;
      else if (
        citations.some(
          (citation) => cursor >= citation.start && cursor < citation.end,
        )
      )
        runEnd = cursor + 1;
      else if (
        punctuation.includes(character) &&
        isHebrew(
          Array.from(text.slice(cursor + 1, end)).find(
            (c) => !isSpace(c) && !punctuation.includes(c),
          ) ?? '',
        )
      )
        runEnd = cursor + 1;
      else break;
      cursor++;
    }
    segments.push({ start: runStart, end: runEnd });
  }
  return segments;
}

// Match Lectern's outline: separate a leading bold source label, but retain
// emphasis inside a continuing Hebrew phrase without changing its word order.
export function directionalNotesRuns<T extends InlineRun>(runs: T[]): T[] {
  const text = runs.map((run) => run.text).join('');
  const first = runs.findIndex((run) => run.text.trim());
  let labelEnd: number | undefined;
  if (first >= 0 && runs[first].bold) {
    labelEnd = runs
      .slice(0, first)
      .reduce((offset, run) => offset + run.text.length, 0);
    for (let i = first; i < runs.length && runs[i].bold; i++)
      labelEnd += runs[i].text.length;
  }
  const boundaries = [
    0,
    ...(labelEnd === undefined ? [] : [labelEnd]),
    text.length,
  ];
  const insertions: Insertion[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    // Hard line breaks are independent lines, even inside a Markdown paragraph.
    let start = boundaries[i - 1];
    for (const line of text.slice(start, boundaries[i]).split('\n')) {
      for (const segment of hebrewSegments(
        text,
        start,
        start + line.length,
        boundaries[i] === labelEnd,
      )) {
        const rtlBoundary =
          !isHebrew(text[segment.start]) || !isHebrew(text[segment.end - 1]);
        insertions.push({
          offset: segment.start,
          text: rtlBoundary ? LRM + RLM : LRM,
          opening: true,
        });
        insertions.push({
          offset: segment.end,
          text: rtlBoundary ? RLM + LRM : LRM,
        });
      }
      start += line.length + 1;
    }
  }
  let offset = 0;
  let insertion = 0;
  return runs.map((run) => {
    const end = offset + run.text.length;
    let anchored = '';
    let cursor = offset;
    while (
      insertion < insertions.length &&
      (insertions[insertion].offset < end ||
        (insertions[insertion].offset === end &&
          !insertions[insertion].opening))
    ) {
      const next = insertions[insertion++];
      anchored += text.slice(cursor, next.offset) + next.text;
      cursor = next.offset;
    }
    anchored += text.slice(cursor, end);
    offset = end;
    return { ...run, text: anchored };
  });
}

export function remarkNotesDirection() {
  return (root: Root) => {
    function visit(nodes: RootContent[]) {
      for (const node of nodes) {
        if (node.type === 'heading' || node.type === 'paragraph') {
          const leaves: {
            text: string;
            bold: boolean;
            set: (text: string) => void;
          }[] = [];
          function inline(children: PhrasingContent[], bold = false) {
            for (const child of children) {
              if (child.type === 'text' || child.type === 'inlineCode') {
                leaves.push({
                  text: child.value,
                  bold,
                  set: (value) => {
                    child.value = value;
                  },
                });
              } else if (child.type === 'break') {
                leaves.push({ text: '\n', bold, set: () => {} });
              } else if ('children' in child)
                inline(child.children, bold || child.type === 'strong');
            }
          }
          inline(node.children);
          directionalNotesRuns(leaves).forEach((leaf) => leaf.set(leaf.text));
        } else if ('children' in node) visit(node.children as RootContent[]);
      }
    }
    visit(root.children);
  };
}
