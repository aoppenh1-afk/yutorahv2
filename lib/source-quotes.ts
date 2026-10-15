import {
  refMetadata,
  searchPassage,
  sefariaUrl,
  sourceText,
  type SefariaFetch,
  type SourceText,
  type RefMetadata,
  type SourceVersion,
} from './sefaria';
import type { TranscriptSource } from './sources';

export type QuoteCandidate = { text: string; start: number; end: number };
export type QuoteReview = {
  reason:
    | 'ambiguous_quote'
    | 'unmatched_quote'
    | 'unverified_quote'
    | 'search_limit';
  candidates?: string[];
};
const common = new Set(
  'אמר אומר רב רבא רבי רבנן הוא היא זה זו של את על אל לא אין יש כל אם כי או מן עם גם the and that this said says rabbi was were for from with you your have has'.split(
    ' ',
  ),
);

/** Ignore cantillation, vowels, markup, and punctuation, without changing the word order. */
export function normalizedQuote(text: string) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0591-\u05bd\u05bf-\u05c7\u200e\u200f]/gu, '')
    .toLowerCase()
    .replace(/[״׳'’"]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function distinctiveQuote(text: string) {
  const normalized = normalizedQuote(text),
    words = normalized.split(' ');
  const hebrew = /[א-ת]/u.test(normalized);
  return (
    words.length >= (hebrew ? 7 : 10) &&
    normalized.length >= (hebrew ? 32 : 50) &&
    new Set(words.filter((word) => word.length > 1 && !common.has(word)))
      .size >= 4
  );
}

/** Hebrew/Aramaic readings need no quote marks; English readings need a quote or reading cue. */
export function quoteCandidates(text: string): QuoteCandidate[] {
  const runs = [
    ...Array.from(
      text.matchAll(
        /[\u0590-\u05ff]+(?:[\s״׳"'’־,.:;!?()-]+[\u0590-\u05ff]+)*/gu,
      ),
      (m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }),
    ),
    ...Array.from(text.matchAll(/["“]([^"”]{50,650})["”]/gu), (m) => ({
      text: m[1],
      start: m.index + 1,
      end: m.index + 1 + m[1].length,
    })),
    ...Array.from(
      text.matchAll(
        /\b(?:it (?:says|reads)|the (?:verse|text|gemara|mishnah) (?:says|reads)|as (?:it is )?written)\s*[:,]?\s+([^.!?]{50,650})/giu,
      ),
      (m) => ({
        text: m[1],
        start: m.index + m[0].indexOf(m[1]),
        end: m.index + m[0].length,
      }),
    ),
  ].sort((a, b) => a.start - b.start);
  const candidates: QuoteCandidate[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const words = [...run.text.matchAll(/\S+/gu)];
    const starts = new Set(
      Array.from({ length: Math.ceil(words.length / 10) }, (_, i) => i * 10),
    );
    // Add one anchor after a clear reading cue. Retain the full opening too:
    // the same wording can be part of the source itself.
    const opening = words.slice(0, 8).map((word) => normalizedQuote(word[0]));
    for (let i = opening.length - 1; i >= 0; i--) {
      if (
        /^(?:שנאמר|כדכתיב|דכתיב|וכתיב)$/u.test(opening[i]) ||
        (i > 0 &&
          /^(?:כך|וכך)$/u.test(opening[i - 1]) &&
          /^(?:כתוב|נאמר)$/u.test(opening[i])) ||
        (i > 0 &&
          /^(?:זה|וזה|זו|וזו)$/u.test(opening[i - 1]) &&
          opening[i] === 'לשונו')
      ) {
        if (i + 1 < words.length) starts.add(i + 1);
        break;
      }
    }
    for (const i of [...starts].sort((a, b) => a - b)) {
      const last = Math.min(words.length, i + 14);
      const start = run.start + words[i].index;
      const end = run.start + words[last - 1].index + words[last - 1][0].length;
      const quote = { text: text.slice(start, end), start, end };
      const key = `${start}:${end}:${normalizedQuote(quote.text)}`;
      if (distinctiveQuote(quote.text) && !seen.has(key)) {
        candidates.push(quote);
        seen.add(key);
      }
    }
  }
  return candidates;
}

export type QuoteResolution = {
  source?: Omit<TranscriptSource, 'occurrences'>;
  review?: QuoteReview;
  contextual?: boolean;
};
type QuoteLibrary = {
  reference: (ref: string) => Promise<RefMetadata | null>;
  text: (ref: string, version?: SourceVersion) => Promise<SourceText>;
};

/** Share canonical lookups across different passages, without caching failures. */
export function createQuoteResolver(
  fetcher: SefariaFetch = fetch,
  loadText: (ref: string) => Promise<SourceText> = (ref) =>
    sourceText(ref, fetcher, 'full'),
) {
  const references = new Map<string, Promise<RefMetadata | null>>();
  const texts = new Map<string, Promise<SourceText>>();
  const reuse = <T>(
    cache: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>,
  ) => {
    let pending = cache.get(key);
    if (!pending) {
      pending = load().catch((error) => {
        cache.delete(key);
        throw error;
      });
      cache.set(key, pending);
    }
    return pending;
  };
  const library: QuoteLibrary = {
    reference: (ref) => reuse(references, ref, () => refMetadata(ref, fetcher)),
    text: (ref, version) =>
      reuse(texts, JSON.stringify([ref, version]), () =>
        version ? sourceText(ref, fetcher, 'full', version) : loadText(ref),
      ),
  };
  return (quote: string, scopes: string[]) =>
    verifyQuote(quote, scopes, fetcher, library);
}
function inScope(ref: string, scope: string) {
  return (
    ref === scope || ref.startsWith(scope + ':') || ref.startsWith(scope + '.')
  );
}

/** Exact numbered context can verify directly; search rank never proves uniqueness. */
export async function resolveQuote(
  quote: string,
  scopes: string[],
  fetcher: SefariaFetch = fetch,
): Promise<QuoteResolution> {
  return createQuoteResolver(fetcher)(quote, scopes);
}

async function verifyQuote(
  quote: string,
  scopes: string[],
  fetcher: SefariaFetch,
  library: QuoteLibrary,
): Promise<QuoteResolution> {
  if (!distinctiveQuote(quote)) return {};
  const needle = ` ${normalizedQuote(quote)} `;
  const contains = (text: SourceText, ref: string, version?: SourceVersion) =>
    text.ref === ref &&
    text.editions.some(
      (edition) =>
        (!version ||
          (edition.title === version.title &&
            (version.language === 'english'
              ? /^(?:en|eng|english)$/iu.test(edition.language)
              : /^(?:he|heb|hebrew)$/iu.test(edition.language)))) &&
        !edition.truncated &&
        ` ${normalizedQuote(edition.text.join(' '))} `.includes(needle),
    );
  if (scopes.length === 1 && /:\d/u.test(scopes[0])) {
    const cited = await library.reference(scopes[0]);
    if (isSegment(cited) && cited.normalized === scopes[0]) {
      const text = await library.text(cited.normalized);
      if (contains(text, cited.normalized))
        return identified(cited, text, true);
    }
  }
  const data = await searchPassage(normalizedQuote(quote), fetcher);
  const hits = data?.hits?.hits;
  if (
    !Array.isArray(hits) ||
    data.error ||
    data.timed_out ||
    data._shards?.failed > 0
  )
    throw new Error('Sefaria could not complete the quotation search.');
  const total =
    typeof data.hits.total === 'number'
      ? data.hits.total
      : data.hits.total?.value;
  if (
    !Number.isSafeInteger(total) ||
    (typeof data.hits.total !== 'number' &&
      data.hits.total?.relation !== 'eq') ||
    total < 0 ||
    total !== hits.length
  )
    return { review: { reason: 'search_limit' } };
  const refs = [
    ...new Set<string>(
      hits.flatMap((hit) =>
        typeof hit?._source?.ref === 'string' && hit._source.ref.length < 250
          ? [hit._source.ref]
          : [],
      ),
    ),
  ];
  if (
    hits.some(
      (hit) =>
        typeof hit?._source?.ref !== 'string' || hit._source.ref.length >= 250,
    )
  )
    return { review: { reason: 'unverified_quote' } };
  if (refs.length === 0) return { review: { reason: 'unmatched_quote' } };
  let choices = refs;
  if (refs.length > 1 && scopes.length) {
    const scoped = refs.filter((ref) =>
      scopes.some((scope) => inScope(ref, scope)),
    );
    if (scoped.length) choices = scoped;
  }
  if (choices.length !== 1)
    return {
      review: { reason: 'ambiguous_quote', candidates: choices.slice(0, 5) },
    };
  const meta = await library.reference(choices[0]);
  // A reading identifies a segment, not a guessed daf/chapter or a default child node.
  if (!isSegment(meta)) return { review: { reason: 'unverified_quote' } };
  const text = await library.text(meta.normalized);
  if (!contains(text, meta.normalized)) {
    // The search index can match an edition other than the primary text. Fetch
    // that named edition and check its identity and words; the index alone is not proof.
    const versions: SourceVersion[] = [];
    for (const hit of hits) {
      const entry = hit?._source;
      if (
        entry.ref !== choices[0] ||
        typeof entry.version !== 'string' ||
        !entry.version.trim() ||
        entry.version.length > 300 ||
        /[|\p{Cc}]/u.test(entry.version) ||
        !['en', 'he'].includes(entry.lang) ||
        typeof entry.exact !== 'string' ||
        !` ${normalizedQuote(entry.exact)} `.includes(needle)
      )
        continue;
      const language = entry.lang === 'en' ? 'english' : 'hebrew';
      if (
        !versions.some(
          (v) => v.language === language && v.title === entry.version,
        )
      )
        versions.push({ language, title: entry.version });
    }
    const checked = await Promise.allSettled(
      versions
        .slice(0, 2)
        .map(async (version) =>
          contains(
            await library.text(meta.normalized, version),
            meta.normalized,
            version,
          ),
        ),
    );
    if (
      !checked.some((result) => result.status === 'fulfilled' && result.value)
    ) {
      const failed = checked.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return { review: { reason: 'unverified_quote' } };
    }
  }
  return identified(meta, text, refs.length > 1);
}

function isSegment(meta: RefMetadata | null): meta is RefMetadata {
  return (
    !!meta &&
    !!sefariaUrl(meta.url_ref) &&
    meta.start_indexes.length === meta.depth &&
    meta.end_indexes.length === meta.depth &&
    meta.start_indexes.every((value, i) => value === meta.end_indexes[i])
  );
}

function identified(
  meta: RefMetadata,
  text: SourceText,
  contextual: boolean,
): QuoteResolution {
  return {
    contextual,
    source: {
      ref: meta.normalized,
      heRef: meta.hebrew,
      url: sefariaUrl(meta.url_ref)!,
      category: text.categories[0] || 'Source',
    },
  };
}
