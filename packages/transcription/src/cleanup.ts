import type { Segment, Transcript } from './types.js';

/** Remove only nonlexical hesitation sounds; meaningful discourse stays verbatim. */
export function cleanFillerWords(text: string): string {
  // Unicode boundaries protect Hebrew/transliterations, contractions and compounds
  // such as uh-huh/uh-oh. Uppercase abbreviations (UM) are not hesitation sounds.
  const filler =
    /(?<![\p{L}\p{N}\p{M}'’-])(u+m+|u+h+|e+r+m+)(?![\p{L}\p{N}\p{M}'’-])[ \t]*[,;:]?[ \t]*/giu;
  let removed = false;
  const cleaned = text.replace(
    filler,
    (match: string, word: string, offset: number) => {
      if (word === word.toUpperCase()) return match;
      // A quoted word may be a discussion of the filler itself.
      if (
        /["“‘]/u.test(text[offset - 1] ?? '') &&
        /["”’]/u.test(text[offset + word.length] ?? '')
      )
        return match;
      removed = true;
      return '';
    },
  );
  if (!removed) return text;
  return cleaned
    .replace(/[ \t]+([,;:.!?…])/gu, '$1')
    .replace(/([,;:])[ \t]*[,;:]+/gu, '$1')
    .replace(/[,;:][ \t]*([.!?…])/gu, '$1')
    .replace(/^[\s,;:.!?…]+/u, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/([[(])[ \t]+/gu, '$1')
    .replace(/[ \t]+([\])])/gu, '$1')
    .replace(/\(\s*\)|\[\s*\]/gu, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

/** Run after overlap merging, leaving accepted checkpoints and timing untouched. */
export function cleanTranscript(transcript: Transcript): Transcript {
  const segments: Segment[] = transcript.segments.flatMap((segment) => {
    const text = cleanFillerWords(segment.text);
    return text && (text === segment.text || /[\p{L}\p{N}]/u.test(text))
      ? [{ ...segment, text }]
      : [];
  });
  return {
    ...transcript,
    segments,
    text: segments.map((s) => s.text).join('\n\n'),
  };
}
