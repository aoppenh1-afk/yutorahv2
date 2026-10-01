import { searchConcepts } from './search-concepts.js';
import { englishWordForms } from './search-language.js';

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
  [
    'halacha',
    'halakha',
    'halachah',
    'halachot',
    'halachos',
    'hilchot',
    'hilchos',
    'הלכה',
    'הלכות',
  ],
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
const hebrewWords = new Set(
  [
    ...aliases.keys(),
    ...searchConcepts.flatMap((concept) =>
      concept.forms.flatMap((form) => searchText(form).split(' ')),
    ),
  ].filter((word) => /^[א-ת]+$/.test(word)),
);
const hebrewPrefixes = [
  'ו',
  'ה',
  'ב',
  'ל',
  'מ',
  'כ',
  'ש',
  'וב',
  'ול',
  'וה',
  'ומ',
  'וכ',
  'וש',
  'בה',
  'לה',
  'מה',
  'כש',
];

/** Exact known words win; prefixes are removed only with one known reading. */
function lexicalBase(word: string): string {
  if (hebrewWords.has(word)) return word;
  if (/^[א-ת]{4,32}$/.test(word)) {
    const candidates = [
      ...new Set(
        hebrewPrefixes
          .filter(
            (prefix) =>
              word.startsWith(prefix) && word.length - prefix.length >= 2,
          )
          .map((prefix) => word.slice(prefix.length))
          .filter((base) => hebrewWords.has(base)),
      ),
    ];
    if (candidates.length === 1) return candidates[0];
  }
  return englishWordForms(word)[0];
}

function conceptKey(term: string): string {
  return searchText(term).split(' ').map(lexicalBase).join(' ');
}

export function searchAliases(word: string): string[] {
  const normalized = searchText(word);
  const base = lexicalBase(normalized);
  const family = englishWordForms(base);
  const forms = [normalized, ...family, ...(aliases.get(base)?.words ?? [])];
  for (const form of forms.filter((word) => hebrewWords.has(word)))
    for (const prefix of ['ו', 'ה', 'ב', 'ל', 'וב', 'ול', 'וה'])
      forms.push(prefix + form);
  return [...new Set(forms)];
}

const connectingWords = new Set(
  'a an and at about by for from in of on the to with'.split(' '),
);
const concepts = searchConcepts.map((concept) => ({
  ...concept,
  forms: concept.forms.map(searchText),
}));
const conceptForms = new Map(
  concepts.flatMap((concept) =>
    concept.forms.flatMap((form) => [
      [form, concept] as const,
      [conceptKey(form), concept] as const,
    ]),
  ),
);
const knownSubjectWords = new Set(
  [
    ...aliases.keys(),
    ...concepts.flatMap((concept) =>
      concept.forms.flatMap((form) => form.split(' ')),
    ),
    'erev',
  ].map(lexicalBase),
);
const compoundForms = [...conceptForms.keys()]
  .filter((form) => form.includes(' '))
  .sort((a, b) => b.length - a.length);
const compoundPattern = compoundForms
  .map((form) => form.split(' ').join('[\\s-]+'))
  .join('|');
const aliasTokens = new RegExp(
  `"[^"]*"|(?<![\\p{L}\\p{N}])(?:${compoundPattern})(?![\\p{L}\\p{N}])|[\\p{L}\\p{M}\\p{N}'’״׳]+`,
  'giu',
);
const spacingPhrases = [
  'daf yomi',
  'rosh hashana',
  'rosh hashanah',
  'yom kippur',
];

export function searchWords(query: string): string[] {
  const words = searchText(query).split(' ').filter(Boolean);
  const subjects = words.filter((word) => !connectingWords.has(word));
  return subjects.length ? subjects : words;
}

/** Group recognized multiword concepts, then discard non-subject connectors.
 * A query made entirely of connectors is kept literal rather than match-all.
 */
export function searchTerms(query: string): string[] {
  const words = searchText(query).split(' ').filter(Boolean);
  const terms: string[] = [];
  for (let i = 0; i < words.length;) {
    const compound = compoundForms.find((form) =>
      form
        .split(' ')
        .every(
          (word, j) =>
            words[i + j] && lexicalBase(words[i + j]) === lexicalBase(word),
        ),
    );
    if (compound) {
      terms.push(words.slice(i, i + compound.split(' ').length).join(' '));
      i += compound.split(' ').length;
    } else {
      terms.push(words[i++]);
    }
  }
  const subjects = terms.filter((term) => !connectingWords.has(term));
  return subjects.length ? subjects : terms;
}

/** Related concepts expand retrieval; the original wording always survives. */
export function relatedSearchTerms(term: string): string[] {
  const normalized = searchText(term);
  return [
    ...new Set([
      normalized,
      ...(conceptForms.get(conceptKey(normalized))?.forms ?? []),
    ]),
  ];
}

const optionalIntentWords = new Set(
  'a an the my your our their his her its את'.split(' '),
);
const intentPatterns = concepts.flatMap((concept) => [
  ...concept.requests.map((request) => ({
    concept,
    words: searchText(request).split(' '),
    replacement: concept.subject,
    request: true,
  })),
  ...concept.forms.map((form) => ({
    concept,
    words: form.split(' '),
    replacement: form,
    request: false,
  })),
]);

/** Recognize complete subject spans, with optional articles/possessives and
 * dictionary-backed word families. Quoted text and other subjects stay intact.
 * Ambiguous corrections, fuzzy prefixes, and two-edit words are not rewritten.
 */
export function interpretIntent(term: string): {
  term: string;
  labels: string[];
} {
  const tokens = [...term.matchAll(/"[^"]*"|[\p{L}\p{M}\p{N}'’״׳]+/gu)];
  const labels: string[] = [];
  let result = '',
    end = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i][0].startsWith('"')) continue;
    const typed = searchText(tokens[i][0]);
    const known = knownSubjectWords.has(lexicalBase(typed));
    const hits = intentPatterns
      .flatMap((pattern) => {
        if (
          known &&
          pattern.words.length === 1 &&
          lexicalBase(pattern.words[0]) !== lexicalBase(typed)
        )
          return [];
        let pos = i,
          confidence = 0,
          edits = 0,
          matched = 0;
        for (const word of pattern.words) {
          if (optionalIntentWords.has(word)) {
            if (
              tokens[pos] &&
              optionalIntentWords.has(searchText(tokens[pos][0]))
            )
              pos++;
            continue;
          }
          while (
            pos > i &&
            tokens[pos] &&
            optionalIntentWords.has(searchText(tokens[pos][0]))
          )
            pos++;
          const token = tokens[pos];
          if (!token || token[0].startsWith('"')) return [];
          if (
            pos > i &&
            !/^[\s'’״׳-]*$/u.test(
              term.slice(
                tokens[pos - 1].index + tokens[pos - 1][0].length,
                token.index,
              ),
            )
          )
            return [];
          const score = wordMatch(searchText(token[0]), word);
          if (score < 0.9 && score !== 0.65) return [];
          if (score === 0.65) edits++;
          if (edits > 2) return [];
          confidence += score;
          matched++;
          pos++;
        }
        if (!matched || (pattern.words.length === 1 && edits && known))
          return [];
        return [{ ...pattern, count: pos - i, score: confidence / matched }];
      })
      .sort(
        (a, b) =>
          b.count - a.count ||
          b.score - a.score ||
          Number(b.request) - Number(a.request),
      );
    const best = hits[0];
    if (
      !best ||
      hits.some(
        (hit) =>
          hit.concept !== best.concept &&
          hit.count === best.count &&
          Math.abs(hit.score - best.score) < 0.01,
      )
    )
      continue;
    const start = tokens[i].index;
    const last = tokens[i + best.count - 1];
    const next = last.index + last[0].length;
    const original = term.slice(start, next);
    if (searchText(original) !== searchText(best.replacement)) {
      result += term.slice(end, start) + best.replacement;
      labels.push(`${original} → ${best.replacement}`);
      end = next;
    }
    i += best.count - 1;
  }
  return { term: result + term.slice(end), labels: [...new Set(labels)] };
}

/** Common request wording, shared by metadata, smart transcripts, and local
 * searches. Filter extraction stays with the metadata parser. */
export function interpretSearchRequest(query: string): {
  term: string;
  labels: string[];
} {
  const quotes: string[] = [];
  let term = query.replace(/"[^"]+"/g, (quote) => {
    quotes.push(quote);
    return `EXACTREQUESTQUOTE${quotes.length - 1}TOKEN`;
  });
  const labels: string[] = [];
  const intent = interpretIntent(term);
  term = intent.term;
  labels.push(...intent.labels);
  // Hebrew wrappers use Unicode-aware boundaries; JavaScript's \b is ASCII.
  term = term.replace(
    /^(?:(?:מקורות|שיעורים?|שיעור|הלכות)\s+(?:על|בנושא|לגבי)\s+|(?:איך|כיצד|מה|למה|מדוע)\s+)/u,
    '',
  );
  const conversational =
    /\b(?:find|show|recommend|looking for|want|need|how|why|what|which|can|could|would|tell me|explain|teach me|help me|i['’]m|i am|i(?:['’]d| would) like|feeling|struggling)\b/i.test(
      term,
    );
  term = term
    .replace(
      /\b(?:please|find(?: me)?|show(?: me)?|recommend(?: me)?|i(?:['’]m| am) looking for|i(?:['’]d| would) like|i want to (?:learn|listen)(?: about| to)?|i want|i need|help me (?:understand|learn)(?: about)?|teach me about|what does judaism say about|i(?:['’]m| am))\b/gi,
      ' ',
    )
    .replace(
      /\b(?:a|an|some)\s+(?=shiur|lecture|class|lesson|audio|video)/gi,
      '',
    )
    .replace(/\blessons?\s*(?:on|about)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (conversational) {
    term = term
      .replace(/^\s*how (?:does|do) (.+?) work\s*\??\s*$/i, '$1')
      .replace(/\b(?:the )?(?:laws|rules) (?:of|for)\b/gi, ' ')
      .replace(/\b(?:tell me|information about)\b/gi, ' ')
      .replace(
        /\b(?:allowed|permitted|prohibited|forbidden|okay|possible)\b/gi,
        ' ',
      )
      .replace(
        /\b(?:how|what|which|why|can|is|are|does|when|where|do|i|my|the|a|an|to|me|you|your|we|our|of|should|could|would|improve|understand|learn|know|explain|about|be|have|more|feeling)\b/gi,
        ' ',
      )
      .replace(/[?]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    term = term.replace(aliasTokens, (word) => {
      if (word.startsWith('"') || word.includes(' ') || word.includes('-'))
        return word;
      return aliases.get(lexicalBase(searchText(word)))?.canonical ?? word;
    });
    if (term)
      labels.push(
        `${term.split(' ').length === 1 ? 'Topic' : 'Keywords'}: ${term}`,
      );
  }
  term = term.replace(/^[.,;: ]+|[.,;: ]+$/g, '').trim();
  term = term.replace(
    /EXACTREQUESTQUOTE(\d+)TOKEN/g,
    (_, i) => quotes[Number(i)],
  );
  return { term: term.replace(/\s+/g, ' ').trim(), labels };
}

export function intentLabels(term: string): string[] {
  return searchTerms(term).flatMap((subject) => {
    const concept = conceptForms.get(conceptKey(subject));
    return concept
      ? [
          `Related topics: ${[...new Set([subject, ...concept.forms])].slice(0, 4).join(' / ')}`,
        ]
      : [];
  });
}

/** Repair word boundaries only when the known vocabulary has one reading.
 * Directory names supply archive-specific names without guessing arbitrary text.
 */
export function interpretSpacing(
  term: string,
  names: string[] = [],
): {
  term: string;
  labels: string[];
} {
  const readings = new Map<string, Set<string>>();
  for (const name of [
    ...aliases.keys(),
    ...conceptForms.keys(),
    ...spacingPhrases,
    ...names,
  ]) {
    const normalized = searchText(name);
    const words = normalized.split(' ');
    const compact = words.join('');
    if (
      compact.length < 5 ||
      compact.length > 64 ||
      words.length > 4 ||
      /\p{N}/u.test(compact)
    )
      continue;
    const forms = readings.get(compact) ?? new Set<string>();
    forms.add(normalized);
    readings.set(compact, forms);
  }
  const tokens = [...term.matchAll(/"[^"]*"|[\p{L}\p{M}\p{N}'’״׳]+/gu)];
  const labels: string[] = [];
  let result = '',
    end = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i][0].startsWith('"')) continue;
    for (let count = Math.min(3, tokens.length - i); count >= 1; count--) {
      const span = tokens.slice(i, i + count);
      if (span.some((token) => token[0].startsWith('"'))) continue;
      const start = span[0].index;
      const next = span.at(-1)!.index + span.at(-1)![0].length;
      const typed = term.slice(start, next);
      if (!/^[\p{L}\p{M}\p{N}'’״׳\s]+$/u.test(typed)) continue;
      const forms = readings.get(searchText(typed).replaceAll(' ', ''));
      if (forms?.size !== 1) continue;
      const reading = [...forms][0];
      if (searchText(typed) === reading) break;
      result += term.slice(end, start) + reading;
      labels.push(`${typed} → ${reading}`);
      end = next;
      i += count - 1;
      break;
    }
  }
  return { term: result + term.slice(end), labels: [...new Set(labels)] };
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
  const queryBase = lexicalBase(query),
    wordBase = lexicalBase(word);
  if (queryBase === wordBase) return 0.92;
  if (aliases.get(queryBase)?.words.includes(wordBase)) return 0.95;
  if (query.length >= minPrefix && word.startsWith(query)) return 0.85;
  const forms = searchAliases(word);
  if (query.length >= minPrefix && forms.some((form) => form.startsWith(query)))
    return 0.8;
  if (knownSubjectWords.has(queryBase) && knownSubjectWords.has(wordBase))
    return 0;
  // Three-letter input can be a four-letter word with a missing/transposed letter.
  // Do not fuzz between short words ("daf" must not become "dav").
  const budget =
    typoBudget(query) || (query.length === 3 && word.length === 4 ? 1 : 0);
  if (!budget || query.length > 64) return 0;
  const fuzzyForms =
    query.length === 3 ? forms.filter((form) => form.length === 4) : forms;
  const distance = Math.min(
    ...fuzzyForms.map((form) => editDistance(query, form, budget, false)),
  );
  if (distance <= budget) return 0.75 - distance * 0.1;
  if (query.length >= minPrefix && (query.length >= 4 || word.length >= 4)) {
    const prefixDistance = Math.min(
      ...fuzzyForms.map((form) => editDistance(query, form, budget, true)),
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
  return searchTerms(
    interpretSearchRequest(interpretSpacing(query, spacingNames(text)).term)
      .term,
  ).every((term) => textMatchScore(text, term, minPrefix) > 0);
}

/** Candidate text supplies a bounded vocabulary for searches within a collection. */
function spacingNames(text: string): string[] {
  const words = searchText(text).split(' ').slice(0, 128);
  return words.flatMap((_, start) =>
    [1, 2, 3].map((count) => words.slice(start, start + count).join(' ')),
  );
}

/** All words in a specific subject remain required; related forms are optional
 * alternatives. Lower related scores keep direct wording ahead of expansion.
 */
export function textMatchScore(
  text: string,
  term: string,
  minPrefix = 3,
): number {
  return textMatchEvidence(text, term, minPrefix).reduce(
    (best, hit) => Math.max(best, hit.score),
    0,
  );
}

/** Subject matches and word positions, shared by coverage and proximity ranking. */
export function textMatchEvidence(
  text: string,
  term: string,
  minPrefix = 3,
): { score: number; start: number; end: number }[] {
  if (!searchText(term)) return [];
  const all = searchText(text)
    .split(' ')
    .filter(Boolean)
    .map((word, index) => ({ word, index }));
  const subjects = all.filter(({ word }) => !connectingWords.has(word));
  const words = subjects.length ? subjects : all;
  return relatedSearchTerms(term).flatMap((form, index) => {
    const tokens = searchWords(form);
    // A compound concept must occur together: unrelated mentions of "lashon"
    // and "Har Gerizim" do not make a lesson about lashon hara.
    return words.flatMap((word, start) => {
      const score = Math.min(
        ...tokens.map((token, j) =>
          words[start + j]
            ? wordMatch(token, words[start + j].word, minPrefix)
            : 0,
        ),
      );
      if (!score || (index > 0 && tokens.length > 1 && score < 0.8)) return [];
      return [
        {
          score: score * (index === 0 ? 1 : 0.6),
          start: word.index,
          end: words[start + tokens.length - 1].index + 1,
        },
      ];
    });
  });
}

/** Positions in the original display string, including accents and Hebrew marks. */
export function matchingSpans(
  text: string,
  query: string,
): { start: number; end: number }[] {
  const safeQuery = query
    .split(/\s+/)
    .filter((word) => /^[\p{L}\p{M}\p{N}'’״׳-]+$/u.test(word))
    .flatMap((word) => searchText(word).split(' '))
    .join(' ');
  const tokens = searchTerms(
    interpretSearchRequest(interpretSpacing(safeQuery, spacingNames(text)).term)
      .term,
  )
    .slice(0, 32)
    .flatMap(relatedSearchTerms)
    .flatMap((term) => term.split(' '))
    .filter((word) => word.length >= 3 && !connectingWords.has(word));
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
  const result = term.replace(aliasTokens, (word) => {
    if (word.startsWith('"') || word.includes(' ') || word.includes('-'))
      return word;
    const normalized = searchText(word);
    const base = lexicalBase(normalized);
    let canonical = aliases.get(base)?.canonical;
    if (!canonical && base !== normalized) canonical = base;
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
      ...concepts.flatMap((concept) => concept.forms.flatMap(searchWords)),
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
  if (letters.length < 4 || letters.length > 12) return [];
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
    // Four-letter substitution wildcards are too broad: "do?n*" matches
    // every "down..." word. Full-word fuzzy retrieval still covers those
    // edits, while transpositions recover short incomplete words (doan/dona).
    if (letters.length === 4) continue;
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
  for (const mode of ['full', 'compact', 'minimal', 'literal'] as const) {
    const query = compileLibrarySearchQuery(term, vocabulary, mode);
    if (encodedQueryLength(query) <= 1800) return query;
  }
  throw new RangeError('Please use a shorter search.');
}

function encodedQueryLength(query: string): number {
  return new URLSearchParams({ searchTerm: query }).toString().length;
}

function compileLibrarySearchQuery(
  term: string,
  vocabulary: string[],
  mode: 'full' | 'compact' | 'minimal' | 'literal',
): string {
  term = interpretSpacing(term).term;
  const normalizedWords = [
    ...new Set(searchText(term).split(' ').filter(Boolean)),
  ];
  const tokens = [...new Set(searchTerms(term))];
  const indexedWords = new Set(vocabulary);
  if (term.trim() && !tokens.length)
    throw new RangeError('Enter a word, topic, or teacher name.');
  if (normalizedWords.length > 32)
    throw new RangeError('Please use up to 32 search words.');
  const compileWord = (token: string, expand = true) => {
    if (mode === 'literal') return token;
    const base = lexicalBase(token);
    const variants = new Set(
      mode === 'full'
        ? searchAliases(token)
        : [
            token,
            ...englishWordForms(base),
            ...(aliases.get(base)?.words ?? []),
          ],
    );
    if (mode === 'minimal') {
      variants.clear();
      variants.add(base);
      const group = aliases.get(base);
      if (group) {
        variants.add(group.words[0]);
        const hebrew = group.words.find((word) => /^[א-ת]+$/.test(word));
        if (hebrew) variants.add(hebrew);
      }
    }
    if (token.length >= 3 && mode !== 'minimal')
      for (const group of aliasGroups)
        if (group.words.some((word) => word.startsWith(token)))
          for (const alias of group.words) variants.add(alias);
    // Known subject aliases already cover their alternative spellings. Fuzzy
    // expansion here would turn, for example, "eruv" into "erev", or "teshuva"
    // into "yeshiva", burying the intended subject in unrelated candidates.
    const budget =
      expand &&
      !indexedWords.has(token) &&
      !knownSubjectWords.has(lexicalBase(token)) &&
      englishWordForms(token).length === 1
        ? typoBudget(token)
        : 0;
    if (expand && !indexedWords.has(token) && token.length >= 3) {
      const completions = vocabulary
        .map((word) => ({ word, score: wordMatch(token, word) }))
        .filter(
          ({ score }) =>
            score > 0 &&
            score < 0.85 &&
            (!knownSubjectWords.has(lexicalBase(token)) || score >= 0.65),
        )
        // The caller orders equal-distance archive words by title frequency.
        .sort((a, b) => b.score - a.score)
        .slice(0, mode === 'minimal' ? 1 : 4);
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
    if (budget && mode === 'full')
      clauses.push(
        ...typoPrefixes(token).slice(
          0,
          Math.floor(1600 / (tokens.length * (token.length + 4))),
        ),
      );
    return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
  };
  return tokens
    .map((token) => {
      let alternatives = relatedSearchTerms(token);
      if (mode === 'literal') alternatives = alternatives.slice(0, 1);
      if (mode === 'minimal') {
        const concept = conceptForms.get(conceptKey(token));
        if (concept) {
          const hebrewIndex = concept.forms.findIndex((form) =>
            /[א-ת]/.test(form),
          );
          alternatives = [
            ...new Set([
              alternatives[0],
              concept.forms[0],
              ...(hebrewIndex > 0
                ? [concept.forms[hebrewIndex - 1], concept.forms[hebrewIndex]]
                : []),
            ]),
          ];
        }
      }
      const forms = alternatives.map((form, index) => {
        const words = searchWords(form).map((word) =>
          compileWord(word, index === 0),
        );
        return words.length === 1 ? words[0] : `(${words.join(' AND ')})`;
      });
      return forms.length === 1 ? forms[0] : `(${forms.join(' OR ')})`;
    })
    .join(' AND ');
}

/** Strict retrieval first; empty queries may omit one unknown secondary word.
 * Known subjects and numbers stay required, with at least two groups per branch.
 * The same policy validates title-only results after retrieval.
 */
export function searchRetrieval(term: string, vocabulary: string[] = []) {
  term = interpretSpacing(term).term;
  const tokens = [...new Set(searchTerms(term))];
  const known = new Set(vocabulary.map(searchText));
  const secondary = new Set(
    'practical basics basic beginner beginners introduction introductory overview guide examples'.split(
      ' ',
    ),
  );
  const optional = tokens
    .map((token, index) => ({ token, index }))
    .filter(
      ({ token }) =>
        !/\p{N}/u.test(token) &&
        !aliases.has(lexicalBase(token)) &&
        !conceptForms.has(conceptKey(token)) &&
        (!known.has(token) || secondary.has(token)),
    );
  const branches =
    tokens.length >= 3 &&
    tokens.length <= 8 &&
    !tokens.some((token) =>
      /^(?:not|no|never|without|except|לא|בלי)$/.test(token),
    )
      ? optional.map(({ index }) => tokens.filter((_, i) => i !== index))
      : [];
  const compiled = branches
    .map(
      (branch) =>
        `(${compileLibrarySearchQuery(branch.join(' '), vocabulary, 'compact')})`,
    )
    .join(' OR ');
  const relatedQuery = encodedQueryLength(compiled) <= 1800 ? compiled : '';
  return {
    strictQuery: librarySearchQuery(term, vocabulary),
    relatedQuery,
    matches(text: string, related = false): boolean {
      const matched = tokens.map((token) => textMatchScore(text, token) > 0);
      return (
        matched.every(Boolean) ||
        (!!related &&
          !!relatedQuery &&
          branches.some((branch) =>
            branch.every((token) => matched[tokens.indexOf(token)]),
          ))
      );
    },
  };
}
