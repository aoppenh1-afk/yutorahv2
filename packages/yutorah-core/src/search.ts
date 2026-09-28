/** Display text is preserved separately. This normalization is for search only. */
export function normalizeTranscriptSearch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/["'\u05f3\u05f4\u2018\u2019\u201c\u201d]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
export const searchNormalizationVersion = '1';
const aliases = [
  ['חזרה', 'chazara', 'chazarah'],
  ['תוס׳', 'תוספות', 'tosfos', 'tosafot', 'tosafos'],
  ['רש״י', 'rashi'],
  ['מיגו', 'migo'],
].map((group) => group.map(normalizeTranscriptSearch));
export function searchVariants(query: string, expandAliases = true): string[] {
  const normalized = normalizeTranscriptSearch(query);
  if (!normalized || query.length > 200 || normalized.split(' ').length > 16)
    throw new Error('Invalid transcript query');
  if (!expandAliases) return [normalized];
  let variants = [''];
  for (const word of normalized.split(' ')) {
    const alternatives = aliases.find((group) => group.includes(word)) ?? [
      word,
    ];
    variants = variants
      .flatMap((prefix) => alternatives.map((w) => `${prefix} ${w}`.trim()))
      .slice(0, 32);
  }
  return [...new Set([normalized, ...variants])];
}
export function timestampLink(shiurId: string, startMs: number): string {
  return `/?shiur=${encodeURIComponent(shiurId)}&t=${Math.floor(startMs / 1000)}`;
}
