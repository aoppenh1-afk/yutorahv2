import { normalizeTranscriptSearch } from '../../yutorah-core/src/search.js';
import type { Segment } from './types.js';

/** Shared by publication and cleanup so adjacent phrase windows stay consistent. */
export function indexedSegments(segments: Segment[]) {
  const normalized = segments.map((s) => normalizeTranscriptSearch(s.text));
  return segments.map((s, i) => ({
    segment_index: i,
    start_ms: s.startMs,
    end_ms: s.endMs,
    text: s.text,
    speaker: s.speaker,
    language: s.language,
    search_text: normalized[i],
    search_window: [
      normalized[i],
      normalized
        .slice(i + 1, i + 17)
        .join(' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 15)
        .join(' '),
    ]
      .join(' ')
      .trim(),
  }));
}
