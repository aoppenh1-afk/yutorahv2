/** Shared by metadata/transcript retrieval, suggestions, ranking, and highlights. */
export function searchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(
      /[\u0300-\u036f\u0591-\u05c7\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      '',
    )
    .toLowerCase()
    .replace(/['’"״׳]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Keep the literal spelling in every group: an alias must expand retrieval,
// rather than erase content written in a different language or transliteration.
const aliasGroups = [
  [
    'teshuva',
    'teshuvah',
    'תשובה',
    'repentance',
    'repent',
    'forgiveness',
    'forgive',
  ],
  [
    'tefillah',
    'tefila',
    'tefilah',
    'tefilla',
    'תפילה',
    'תפלה',
    'prayer',
    'prayers',
    'pray',
    'daven',
    'davening',
  ],
  ['Shabbat', 'shabbos', 'shabbats', 'שבת', 'sabbath'],
  ['kashrut', 'kashrus', 'כשרות', 'kosher'],
  ['emunah', 'emuna', 'אמונה', 'faith', 'belief', 'believe'],
  ['middot', 'midos', 'מידות'],
  ['selichot', 'selichos', 'slichot', 'סליחות'],
  ['sukkot', 'sukkos', 'succot', 'succos', 'סוכות'],
  ['pesach', 'passover', 'פסח'],
  ['shavuot', 'shavuos', 'שבועות'],
  ['chanukah', 'chanuka', 'hanukkah', 'hanukah', 'חנוכה'],
  ['halacha', 'halakha', 'halachah', 'הלכה'],
  ['mitzvot', 'mitzvos', 'מצוות'],
  ['brachot', 'brachos', 'berachot', 'berachos', 'ברכות'],
  ['tzedakah', 'tzedaka', 'צדקה', 'charity'],
  ['chazara', 'chazarah', 'חזרה'],
  ['tosafot', 'tosfos', 'tosafos', 'תוספות', 'תוס'],
  ['rashi', 'רשי'],
  ['rambam', 'maimonides', 'רמבם'],
  ['migo', 'מיגו'],
  ['eruv', 'eiruv', 'עירוב'],
].map((group) => ({ canonical: group[0], words: group.map(searchText) }));

const aliases = new Map(
  aliasGroups.flatMap((group) =>
    group.words.map((word) => [word, group] as const),
  ),
);

export function searchAliases(word: string): string[] {
  const normalized = searchText(word);
  return aliases.get(normalized)?.words ?? [normalized];
}

/** A bounded tolerance, with exact numbers and no fuzzy two-letter words. */
export function typoBudget(word: string): number {
  if (/\p{N}/u.test(word)) return 0;
  const length = Array.from(word).length;
  return length >= 7 ? 2 : length >= 4 ? 1 : 0;
}

/** Damerau-Levenshtein (adjacent transpositions count as one edit).
 * Prefix mode compares against the beginning of the word, without charging for
 * the untyped suffix. Matrix dimensions are bounded by the query, not the field.
 */
function editDistance(
  query: string,
  word: string,
  budget: number,
  prefix: boolean,
): number {
  const a = Array.from(query);
  const all = Array.from(word);
  if (!prefix && Math.abs(a.length - all.length) > budget) return budget + 1;
  const b = prefix ? all.slice(0, a.length + budget) : all;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let beforePrevious = previous;
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
    }
    beforePrevious = previous;
    previous = current;
    if (Math.min(...current) > budget) return budget + 1;
  }
  return prefix
    ? Math.min(...previous.slice(Math.max(1, a.length - budget)))
    : previous[b.length];
}

const wordMatches = new Map<string, number>();

/** Exact > alias > prefix > typo > typo in an incomplete word. */
export function wordMatch(query: string, word: string, minPrefix = 3): number {
  if (minPrefix === 2 && query.length >= 3) minPrefix = 3;
  const key = `${minPrefix}\0${query}\0${word}`;
  const cached = wordMatches.get(key);
  if (cached !== undefined) return cached;
  const score = wordMatchScore(query, word, minPrefix);
  if (wordMatches.size >= 20000)
    wordMatches.delete(wordMatches.keys().next().value!);
  wordMatches.set(key, score);
  return score;
}

function wordMatchScore(
  query: string,
  word: string,
  minPrefix: number,
): number {
  if (query === word) return 1;
  if (!query || !word || /\p{N}/u.test(query)) return 0;
  if (aliases.get(query)?.words.includes(word)) return 0.95;
  if (query.length >= minPrefix && word.startsWith(query)) return 0.85;
  const forms = aliases.get(word)?.words ?? [word];
  if (query.length >= minPrefix && forms.some((form) => form.startsWith(query)))
    return 0.8;
  const budget = typoBudget(query);
  if (!budget || query.length > 64) return 0;
  const distance = Math.min(
    ...forms.map((form) => editDistance(query, form, budget, false)),
  );
  if (distance <= budget) return 0.75 - distance * 0.1;
  if (query.length >= Math.max(4, minPrefix)) {
    const prefixDistance = Math.min(
      ...forms.map((form) => editDistance(query, form, budget, true)),
    );
    if (prefixDistance <= budget) return 0.6 - prefixDistance * 0.1;
  }
  return 0;
}

export function matchQuery(
  text: string,
  query: string,
  minPrefix = 3,
): boolean {
  const words = searchText(text).split(' ');
  return searchText(query)
    .split(' ')
    .filter(Boolean)
    .every((token) =>
      words.some((word) => wordMatch(token, word, minPrefix) > 0),
    );
}

/** Positions in the original display string, including accents and Hebrew marks. */
export function matchingSpans(
  text: string,
  query: string,
): { start: number; end: number }[] {
  const tokens = query
    .split(/\s+/)
    .filter((word) => /^[\p{L}\p{M}\p{N}'’״׳-]+$/u.test(word))
    .flatMap((word) => searchText(word).split(' '))
    .filter((word) => word.length >= 3)
    .slice(0, 32);
  if (!tokens.length) return [];
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’״׳]*/gu))
    if (tokens.some((token) => wordMatch(token, searchText(match[0])) > 0))
      spans.push({ start: match.index, end: match.index + match[0].length });
  return spans;
}

/** Disclosed, exact aliases; quoted text is deliberately left literal. */
export function interpretAliases(term: string): {
  term: string;
  labels: string[];
} {
  const labels: string[] = [];
  const result = term.replace(/"[^"]*"|[\p{L}\p{M}\p{N}'’״׳]+/gu, (word) => {
    if (word.startsWith('"')) return word;
    const normalized = searchText(word);
    let canonical = aliases.get(normalized)?.canonical;
    if (!canonical && normalized.length >= 4) {
      const matches = aliasGroups
        .map((group) => ({
          canonical: group.canonical,
          score: Math.max(
            ...group.words.map((alias) => wordMatch(normalized, alias)),
          ),
        }))
        .filter(({ score }) => score >= 0.55 && score < 0.85)
        .sort((a, b) => b.score - a.score);
      if (matches[0] && (!matches[1] || matches[0].score > matches[1].score))
        canonical = matches[0].canonical;
    }
    if (!canonical || searchText(canonical) === searchText(word)) return word;
    labels.push(`${word} → ${canonical}`);
    return canonical;
  });
  return { term: result, labels: [...new Set(labels)] };
}

export function searchVocabulary(names: string[] = []): string[] {
  return [
    ...new Set([
      ...aliases.keys(),
      ...names.flatMap((name) => searchText(name).split(' ')),
    ]),
  ].filter(
    (word) => word.length >= 3 && word.length <= 64 && !/\p{N}/u.test(word),
  );
}

/** One-edit prefix wildcards recover partial misspellings even when the word
 * is absent from the directory lexicon. No leading wildcard is emitted.
 */
function typoPrefixes(token: string): string[] {
  const letters = Array.from(token);
  if (letters.length < 5 || letters.length > 12) return [];
  const patterns = new Set<string>();
  for (let i = letters.length - 1; i >= 1; i--) {
    const before = letters.slice(0, i).join('');
    const after = letters.slice(i + 1).join('');
    if (i < letters.length - 1 && letters[i] !== letters[i + 1])
      patterns.add(
        before +
          letters[i + 1] +
          letters[i] +
          letters.slice(i + 2).join('') +
          '*',
      );
    patterns.add(before + '?' + after + '*');
    patterns.add(before + after + '*');
    patterns.add(before + '?' + letters.slice(i).join('') + '*');
  }
  if (letters[0] !== letters[1])
    patterns.add(letters[1] + letters[0] + letters.slice(2).join('') + '*');
  return [...patterns];
}

/** Compile literal user text to the public index's supported Solr syntax.
 * AND preserves all subject words. Each clause retains its literal term and
 * expands to prefixes, typos, aliases, and typo-prefixes from the live lexicon.
 * Never interpolate user-supplied operators, field names, wildcards, or boosts.
 */
export function librarySearchQuery(
  term: string,
  vocabulary: string[] = [],
): string {
  const tokens = [...new Set(searchText(term).split(' ').filter(Boolean))];
  if (term.trim() && !tokens.length)
    throw new RangeError('Enter a word, topic, or teacher name.');
  if (tokens.length > 32)
    throw new RangeError('Please use up to 32 search words.');
  return tokens
    .map((token) => {
      const variants = new Set(searchAliases(token));
      if (token.length >= 3)
        for (const group of aliasGroups)
          if (group.words.some((word) => word.startsWith(token)))
            for (const alias of group.words) variants.add(alias);
      // Known subject aliases already cover their alternative spellings. Fuzzy
      // expansion here would turn, for example, "eruv" into "erev", or "teshuva"
      // into "yeshiva", burying the intended subject in unrelated candidates.
      const budget = aliases.has(token) ? 0 : typoBudget(token);
      if (budget) {
        const completions = vocabulary
          .map((word) => ({ word, score: wordMatch(token, word) }))
          .filter(({ score }) => score > 0 && score < 0.85)
          .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word))
          .slice(0, 4);
        for (const { word } of completions)
          for (const alias of searchAliases(word)) variants.add(alias);
      }
      const clauses = [token];
      if (token.length >= 3 && !/\p{N}/u.test(token)) clauses.push(`${token}*`);
      if (budget) clauses.push(`${token}~${budget}`);
      for (const variant of variants)
        if (variant !== token) clauses.push(variant);
      // Keep long multiword URLs bounded. Short, ordinary queries can use every
      // one-edit prefix pattern; larger queries retain the strongest completions.
      if (budget)
        clauses.push(
          ...typoPrefixes(token).slice(
            0,
            Math.floor(1600 / (tokens.length * (token.length + 4))),
          ),
        );
      return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
    })
    .join(' AND ');
}
