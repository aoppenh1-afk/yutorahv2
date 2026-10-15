/** A bounded transliteration key, never a replacement for the displayed word.
 * Exact archive words remain protected by the query interpreter. Requiring a
 * characteristic digraph avoids applying these substitutions to all English.
 */
export function transliterationKey(word: string): string {
  if (
    !/^[a-z]{4,64}$/.test(word) ||
    !/(?:ch|kh|sh|tz|ts|ph|ei|ey|th)/.test(word)
  )
    return '';
  return word
    .replace(/sch/g, 'sh')
    .replace(/ch|kh/g, 'h')
    .replace(/tz|ts/g, 'z')
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/w/g, 'v')
    .replace(/ck|q/g, 'k')
    .replace(/ei|ey|ai|ay|ee/g, 'i')
    .replace(/oo|ou/g, 'u')
    .replace(/(.)\1+/g, '$1')
    .replace(/h$/, '');
}

export function sameTransliteration(a: string, b: string): boolean {
  const key = transliterationKey(a);
  return !!key && key === transliterationKey(b);
}
