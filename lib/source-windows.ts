import { stripNotesDirectionControls } from './notes-direction';
import {
  validateSourceTranscript,
  SourcesLimitError,
  type SourceTranscript,
} from './sources';

export type SourceInput = {
  shiurId: string;
  transcript?: SourceTranscript & { complete?: boolean };
  notes?: { markdown: string; version?: string; sourceHash?: string };
  warnings?: string[];
};
export type SourceUnit = {
  text: string;
  startMs: number;
  endMs: number;
  segmentIndex: number;
  charOffset: number;
  offset: number;
};
export type SourceWindow = {
  origin: 'transcript' | 'notes';
  units: SourceUnit[];
};

/** Stable core groups plus a short lookbehind let appended/corrected tails reuse completed work. */
export function sourceWindows(input: SourceInput): SourceWindow[] {
  const windows: SourceWindow[] = [];
  if (input.transcript) {
    validateSourceTranscript(input.transcript);
    let offset = 0;
    const units = input.transcript.segments.flatMap((segment, segmentIndex) => {
      const parts = splitUnit({
        ...segment,
        segmentIndex,
        charOffset: 0,
        offset,
      });
      offset += segment.text.length + 2;
      return parts;
    });
    for (let from = 0; from < units.length;) {
      let to = from + 1,
        length = units[from].text.length;
      while (
        to < units.length &&
        to - from < 32 &&
        length + units[to].text.length < 9000 &&
        units[to].startMs - units[to - 1].endMs <= 15000
      ) {
        length += units[to].text.length + 2;
        to++;
      }
      const context: SourceUnit[] = [];
      let room = 450;
      for (let i = from - 1; i >= 0 && room > 0; i--) {
        if (
          units[from].startMs - units[i].startMs > 60000 ||
          units[i + 1].startMs - units[i].endMs > 15000
        )
          break;
        const unit = units[i];
        const cut = Math.max(0, unit.text.length - room);
        context.unshift({
          ...unit,
          text: unit.text.slice(cut),
          charOffset: unit.charOffset + cut,
          offset: unit.offset + cut,
        });
        room -= unit.text.length + 2;
      }
      windows.push({
        origin: 'transcript',
        units: [...context, ...units.slice(from, to)],
      });
      from = to;
    }
  }
  if (input.notes) {
    const markdown = stripNotesDirectionControls(input.notes.markdown);
    if (markdown.length > 500000)
      throw new SourcesLimitError(
        'These notes are too large to check for sources.',
      );
    // Preserve offsets while masking destinations, code, and HTML. Notes never supply recording times.
    const masked = markdown.replace(
      /```[\s\S]*?```|`[^`\n]*`|<[^>]*>|\]\([^)]*\)/gu,
      (match) => match.replace(/[^\n]/gu, ' '),
    );
    let index = 0;
    for (const match of masked.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/gu)) {
      const unit = {
        text: match[0],
        startMs: 0,
        endMs: 0,
        segmentIndex: index++,
        charOffset: 0,
        offset: match.index,
      };
      for (const part of splitUnit(unit))
        windows.push({ origin: 'notes', units: [part] });
    }
  }
  if (windows.length > 4000)
    throw new SourcesLimitError(
      'This shiur has too much content to check for sources.',
    );
  return windows;
}

function splitUnit(unit: SourceUnit): SourceUnit[] {
  const parts: SourceUnit[] = [];
  for (let from = 0; from < unit.text.length;) {
    let end = Math.min(unit.text.length, from + 2800);
    if (end < unit.text.length) {
      const space = unit.text.lastIndexOf(' ', end);
      if (space > from + 2000) end = space;
    }
    parts.push({
      ...unit,
      text: unit.text.slice(from, end),
      offset: unit.offset + from,
      charOffset: unit.charOffset + from,
    });
    if (end === unit.text.length) break;
    from = Math.max(from + 1, end - 450);
  }
  return parts;
}
