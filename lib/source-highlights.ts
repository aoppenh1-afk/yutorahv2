import type { TranscriptSource } from './sources';

/** Never overlap anchors or change transcript wording, even if the linker overlaps citations. */
export function sourceHighlights(
  sources: TranscriptSource[],
  segmentIndex: number,
) {
  const spans = sources
    .flatMap((source) =>
      source.occurrences.flatMap((occurrence) =>
        occurrence.spans
          .filter((span) => span.segmentIndex === segmentIndex)
          .map((span) => ({ ...span, ref: source.ref, url: source.url })),
      ),
    )
    .sort((a, b) => a.startChar - b.startChar || b.endChar - a.endChar);
  let end = 0;
  return spans.filter((span) => {
    if (span.startChar < end || span.endChar <= span.startChar) return false;
    end = span.endChar;
    return true;
  });
}
