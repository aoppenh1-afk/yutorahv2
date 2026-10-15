import { parseVtt } from '../../../lib/webvtt.mjs';

export const NOTES_LANGUAGE_POLICY = 'english-prose-1';
export const LANGUAGE_VIOLATION =
  'Use English explanatory prose with Hebrew terminology unless the complete transcript is also Hebrew; this draft is entirely or overwhelmingly Hebrew.';

export function scriptEvidence(text: string) {
  const clean = text.replace(/https?:\/\/\S+/gi, '');
  const latin = clean.match(/[a-z]/gi)?.length ?? 0;
  const hebrew = clean.match(/[\u05d0-\u05ea]/g)?.length ?? 0;
  return { latin, hebrew, latinFraction: latin / Math.max(1, latin + hebrew) };
}
/** Titles/URLs cannot stand in for English explanation. Script ratios are a language guard, not a fidelity score. */
export function hebrewNotesBody(markdown: string) {
  const evidence = scriptEvidence(
    markdown.replace(/^\s*#{1,6}[ \t]+.*$/gm, ''),
  );
  return (
    evidence.hebrew > 0 &&
    (evidence.latin === 0 ||
      (evidence.hebrew >= 40 && evidence.latinFraction < 0.1))
  );
}
export function assessNotesLanguage(markdown: string, source: string) {
  const notes = scriptEvidence(markdown.replace(/^\s*#{1,6}[ \t]+.*$/gm, ''));
  const transcript = scriptEvidence(source);
  const hebrewSource =
    transcript.hebrew > 0 &&
    (transcript.latin === 0 ||
      (transcript.hebrew >= 40 && transcript.latinFraction <= 0.05));
  return {
    policy: NOTES_LANGUAGE_POLICY,
    notes,
    transcript,
    hebrewSource,
    unexpectedHebrew: hebrewNotesBody(markdown) && !hebrewSource,
  };
}
export function transcriptText(vtt: string) {
  return parseVtt(vtt)
    .map((c) =>
      c.text
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"'),
    )
    .join('\n\n');
}
