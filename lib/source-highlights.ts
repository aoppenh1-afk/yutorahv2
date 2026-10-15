import type { TranscriptSource } from './sources';

/** Never overlap anchors or change transcript wording, even if the linker overlaps citations. */
export function sourceHighlights(
  sources: TranscriptSource[],
  segmentIndex: number,
) {
  return indexSourceHighlights(sources).get(segmentIndex) ?? [];
}
export function indexSourceHighlights(sources: TranscriptSource[]) {
  type Span = TranscriptSource['occurrences'][number]['spans'][number] & {
    ref: string;
    url: string;
  };
  const grouped = new Map<number, Span[]>();
  for (const source of sources)
    for (const occurrence of source.occurrences)
      if (!occurrence.origin || occurrence.origin === 'transcript')
        for (const span of occurrence.spans) {
          const spans = grouped.get(span.segmentIndex) ?? [];
          spans.push({ ...span, ref: source.ref, url: source.url });
          grouped.set(span.segmentIndex, spans);
        }
  for (const [index, spans] of grouped)
    grouped.set(index, nonOverlapping(spans));
  return grouped;
}
function nonOverlapping<T extends { startChar: number; endChar: number }>(
  spans: T[],
) {
  spans.sort((a, b) => a.startChar - b.startChar || b.endChar - a.endChar);
  let end = 0;
  return spans.filter((span) => {
    if (span.startChar < end || span.endChar <= span.startChar) return false;
    end = span.endChar;
    return true;
  });
}
