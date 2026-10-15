import type { SearchDatabase } from './search-storage';
import {
  advanceSources,
  type SourceOccurrence,
  type TranscriptSource,
  type SourcesResult,
} from './sources';
import type { SefariaFetch } from './sefaria';
import {
  sourceWindows,
  type SourceInput,
  type SourceWindow,
} from './source-windows';
import {
  quoteCandidates,
  normalizedQuote,
  createQuoteResolver,
  type QuoteReview,
  type QuoteResolution,
} from './source-quotes';
import { cachedSourceText, assertSourceStorageCapacity } from './sources-cache';

// Increment when detection/acceptance changes. Old accepted results must not bypass new checks.
export const sourceCreatorPolicy = 'creator-v4';
const policy = sourceCreatorPolicy;
const maxQuotes = 12;
const lifetime = 30 * 86400_000;
export type SourceReview = {
  id: string;
  reason: string;
  mention: string;
  origin: 'transcript' | 'notes';
  startMs: number;
  candidates?: string[];
};
export type SourceCreatorResult = SourcesResult & {
  inputVersion: string;
  notesVersion?: string;
  transcriptComplete: boolean;
  reviews: SourceReview[];
  reviewCount: number;
  checkedWindows: number;
  totalWindows: number;
  warnings: string[];
};
type WindowResult = {
  sources: TranscriptSource[];
  reviews: SourceReview[];
  limited: boolean;
  done: boolean;
};
type CreatorState = WindowResult & {
  cursor: number;
  quoteIndex: number;
  citationsReady: boolean;
  current: WindowResult;
  reviewCount: number;
};
type Row = { payload: string; lease: number; expires: number };
const emptyWindow = (): WindowResult => ({
  sources: [],
  reviews: [],
  limited: false,
  done: false,
});
export async function sourceHash(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
async function read<T>(db: SearchDatabase, key: string): Promise<T | null> {
  const row = await db
    .prepare('SELECT payload FROM sources_runs WHERE id=? AND expires>?')
    .bind(key, Date.now())
    .first<Row>();
  return row ? (JSON.parse(row.payload) as T) : null;
}
async function write(
  db: SearchDatabase,
  key: string,
  value: unknown,
  duration = lifetime,
) {
  const payload = JSON.stringify(value);
  if (payload.length > 800000)
    throw new Error('This source result is too large to save.');
  await db
    .prepare(
      'INSERT INTO sources_runs (id,payload,lease,expires) VALUES (?,?,0,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires',
    )
    .bind(key, payload, Date.now() + duration)
    .run();
}

/** Advance a bounded set of checkpoints, yielding when Sefaria needs more time. */
export async function advanceSourceCreator(
  db: SearchDatabase,
  input: SourceInput,
  fetcher: SefariaFetch = fetch,
): Promise<SourceCreatorResult> {
  const windows = sourceWindows(input);
  const inputVersion = await sourceHash({
    policy,
    shiurId: input.shiurId,
    transcript: input.transcript,
    notes: input.notes,
  });
  const key = `${policy}:${inputVersion}`;
  const preparedKey = `prepared:${policy}:${input.shiurId}`;
  const prepared = await read<SourceCreatorResult>(db, preparedKey);
  if (prepared?.inputVersion === inputVersion && prepared.status === 'ready')
    return {
      ...prepared,
      warnings: input.warnings || [],
      transcriptComplete: input.transcript?.complete !== false,
    };
  await assertSourceStorageCapacity(db);
  const cachedState = await read<CreatorState>(db, key);
  let state: CreatorState = cachedState || {
    ...emptyWindow(),
    cursor: 0,
    quoteIndex: 0,
    citationsReady: false,
    current: emptyWindow(),
    reviewCount: 0,
    done: !windows.length,
  };
  if (!cachedState) {
    await db
      .prepare(
        'DELETE FROM sources_runs WHERE id = ? AND expires < ? AND lease < ?',
      )
      .bind(key, Date.now(), Date.now())
      .run();
    await db
      .prepare(
        'INSERT INTO sources_runs (id,payload,lease,expires) VALUES (?,?,0,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(key, JSON.stringify(state), Date.now() + lifetime)
      .run();
  }
  const reply = (
    current: CreatorState,
    waiting = false,
  ): SourceCreatorResult => {
    const sources = current.sources.map((source) => ({
      ...source,
      occurrences: [...source.occurrences],
    }));
    const window = windows[current.cursor];
    if (window)
      mergeSources(sources, mapWindow(current.current, window).sources);
    const reviews = [
      ...current.reviews,
      ...(window ? mapWindow(current.current, window).reviews : []),
    ].slice(0, 80);
    return {
      transcriptId: input.transcript?.transcriptId || `notes-${input.shiurId}`,
      inputVersion,
      notesVersion: input.notes?.version,
      transcriptComplete: input.transcript?.complete !== false,
      waiting,
      status: current.done ? 'ready' : 'pending',
      progress: current.done
        ? 100
        : Math.min(
            99,
            Math.floor((current.cursor / Math.max(1, windows.length)) * 100),
          ),
      sources,
      reviews,
      reviewCount: current.reviewCount + current.current.reviews.length,
      checkedWindows: current.cursor,
      totalWindows: windows.length,
      limited: current.limited || current.current.limited,
      omitted: reviews.length,
      omissions: [],
      omissionCounts: {},
      warnings: input.warnings || [],
    };
  };
  if (state.done) {
    const result = reply(state);
    await write(db, preparedKey, result, 365 * 86400_000);
    return result;
  }
  const now = Date.now(),
    lease = now + 60000;
  const claimed = await db
    .prepare('UPDATE sources_runs SET lease = ? WHERE id = ? AND lease < ?')
    .bind(lease, key, now)
    .run();
  if (!claimed.meta.changes)
    return reply((await read<CreatorState>(db, key)) || state, true);
  const checkpoint = async () => {
    const payload = JSON.stringify(state);
    if (payload.length > 800000)
      throw new Error('This source result is too large to save.');
    const saved = await db
      .prepare(
        'UPDATE sources_runs SET payload = ?, expires = ? WHERE id = ? AND lease = ? AND lease > ?',
      )
      .bind(payload, Date.now() + lifetime, key, lease, Date.now())
      .run();
    if (!saved.meta.changes)
      throw new Error(
        'Source processing changed ownership. Retry to continue.',
      );
  };
  try {
    state = (await read<CreatorState>(db, key))!;
    if (state.done) return reply(state);
    const inFlightQuotes = new Map<string, Promise<QuoteResolution>>();
    const resolveQuote = createQuoteResolver(fetcher, (ref) =>
      cachedSourceText(db, ref, fetcher, 'full'),
    );
    const deadline = Date.now() + 6000;
    let waiting = false;
    for (let step = 0; step < 6 && !state.done; step++) {
      waiting = false;
      const window = windows[state.cursor];
      const local = {
        segments: window.units.map(({ text, startMs, endMs }) => ({
          text,
          startMs,
          endMs,
        })),
      };
      const windowHash = await sourceHash({
        policy,
        origin: window.origin,
        ...local,
      });
      const windowKey = `${policy}:window:${windowHash}`;
      const cached = await read<WindowResult>(db, windowKey);
      if (cached?.done) {
        completeWindow(state, cached, window);
      } else {
        if (!state.citationsReady) {
          const citations = await advanceSources(
            db,
            { ...local, transcriptId: windowHash },
            fetcher,
          );
          state.current.sources = citations.sources
            .filter((s) =>
              s.occurrences.some((o) => boundedOccurrence(o, window)),
            )
            .map((source) => ({
              ...source,
              occurrences: source.occurrences
                .filter((o) => boundedOccurrence(o, window))
                .map((o) => ({
                  ...o,
                  method: 'citation' as const,
                  verification: 'Explicit reference validated by Sefaria',
                })),
            }));
          state.current.reviews = citations.omissions.map((o) => ({
            id: `${o.offset}:${o.reason}`,
            reason: o.reason,
            mention: o.mention,
            startMs: o.startMs,
            origin: window.origin,
          }));
          state.current.sources = state.current.sources.flatMap((source) => {
            const occurrences = source.occurrences.filter((o) => {
              if (hasRequiredSection(source.ref, o.mention)) return true;
              state.current.reviews.push({
                id: `${o.offset}:missing_section`,
                reason: 'missing_section',
                mention: o.mention,
                startMs: o.startMs,
                origin: window.origin,
              });
              return false;
            });
            return occurrences.length ? [{ ...source, occurrences }] : [];
          });
          state.current.limited ||= citations.limited;
          state.citationsReady = citations.status === 'ready';
          waiting = !state.citationsReady && citations.waiting !== false;
        } else {
          const text = window.units.map((u) => u.text).join('\n\n');
          const quotes = quoteCandidates(text);
          if (quotes.length > maxQuotes) state.current.limited = true;
          const batch = quotes
            .slice(0, maxQuotes)
            .slice(state.quoteIndex, state.quoteIndex + 3);
          const checked = await Promise.allSettled(
            batch.map(async (quote) => {
              const occurrence = quoteOccurrence(
                text,
                quote.start,
                quote.end,
                window,
              );
              if (!occurrence || !boundedOccurrence(occurrence, window))
                return null;
              const preceding = state.current.sources.flatMap((source) =>
                source.occurrences
                  .filter(
                    (o) =>
                      o.method === 'citation' &&
                      o.offset + o.mention.length <= occurrence.offset &&
                      occurrence.offset - o.offset <= 450 &&
                      (window.origin === 'notes' ||
                        Math.abs(o.startMs - occurrence.startMs) <= 60000),
                  )
                  .map((o) => ({
                    ref: source.ref,
                    end: o.offset + o.mention.length,
                  })),
              );
              const nearest = Math.max(
                -1,
                ...preceding.map((citation) => citation.end),
              );
              const scopes = [
                ...new Set(
                  preceding
                    .filter((citation) => citation.end === nearest)
                    .map((citation) => citation.ref),
                ),
              ].sort();
              const quoteKey = `${policy}:quote:${await sourceHash({ quote: normalizedQuote(quote.text), scopes })}`;
              let pending = inFlightQuotes.get(quoteKey);
              if (!pending) {
                pending = (async () => {
                  const cached = await read<QuoteResolution>(db, quoteKey);
                  if (cached) return cached;
                  const resolution = await resolveQuote(quote.text, scopes);
                  await write(db, quoteKey, { ...resolution, done: true });
                  return resolution;
                })();
                inFlightQuotes.set(quoteKey, pending);
              }
              const resolution = await pending;
              return { quote, occurrence, resolution };
            }),
          );
          for (const checkedQuote of checked) {
            if (checkedQuote.status !== 'fulfilled' || !checkedQuote.value)
              continue;
            const { quote, occurrence, resolution } = checkedQuote.value;
            if (resolution.source)
              mergeSources(state.current.sources, [
                {
                  ...resolution.source,
                  occurrences: [
                    {
                      ...occurrence,
                      method: 'quotation',
                      verification: resolution.contextual
                        ? 'Passage text verified against the nearby citation'
                        : 'Distinctive passage verified at a unique Sefaria location',
                    },
                  ],
                },
              ]);
            else if (resolution.review)
              addQuoteReview(
                state.current,
                resolution.review,
                quote.text,
                occurrence,
                window,
              );
          }
          const firstFailure = checked.findIndex(
            (result) => result.status === 'rejected',
          );
          if (firstFailure >= 0) {
            state.quoteIndex += firstFailure;
            await checkpoint();
            const failure = checked[firstFailure];
            if (failure.status === 'rejected') throw failure.reason;
          }
          state.quoteIndex += batch.length;
          if (state.quoteIndex >= Math.min(quotes.length, maxQuotes)) {
            state.current.done = true;
            await write(db, windowKey, state.current);
            completeWindow(state, state.current, window);
          }
        }
      }
      state.done = state.cursor >= windows.length;
      await checkpoint();
      if (waiting || Date.now() >= deadline) break;
    }
    const result = reply(state, waiting);
    if (state.done) await write(db, preparedKey, result, 365 * 86400_000);
    return result;
  } finally {
    await db
      .prepare('UPDATE sources_runs SET lease = 0 WHERE id = ? AND lease = ?')
      .bind(key, lease)
      .run();
  }
}

function completeWindow(
  state: CreatorState,
  result: WindowResult,
  window: SourceWindow,
) {
  const mapped = mapWindow(result, window);
  mergeSources(state.sources, mapped.sources);
  for (const review of mapped.reviews) {
    if (state.reviews.some((r) => r.id === review.id)) continue;
    state.reviewCount++;
    if (state.reviews.length < 80) state.reviews.push(review);
  }
  state.limited ||= result.limited;
  if (state.sources.length > 150) {
    state.sources.length = 150;
    state.limited = true;
  }
  for (const source of state.sources)
    if (source.occurrences.length > 60) {
      source.occurrences.length = 60;
      state.limited = true;
    }
  state.cursor++;
  state.quoteIndex = 0;
  state.citationsReady = false;
  state.current = emptyWindow();
}
function mergeSources(target: TranscriptSource[], sources: TranscriptSource[]) {
  const occurrenceKey = (o: SourceOccurrence) =>
    `${o.origin || ''}:${o.offset}:${o.method || ''}`;
  for (const source of sources) {
    let existing = target.find((s) => s.ref === source.ref);
    if (!existing) {
      existing = { ...source, occurrences: [] };
      target.push(existing);
    }
    for (const occurrence of source.occurrences) {
      const sameMention = (o: SourceOccurrence) =>
        o.method === 'citation' &&
        occurrence.method === 'citation' &&
        o.origin === occurrence.origin &&
        o.offset === occurrence.offset;
      // Appended address details refine that same mention rather than duplicating its earlier chapter/siman.
      let superseded = false;
      for (const other of target) {
        if (other.ref === source.ref) continue;
        if (source.ref.startsWith(other.ref + ':'))
          other.occurrences = other.occurrences.filter((o) => !sameMention(o));
        else if (
          other.ref.startsWith(source.ref + ':') &&
          other.occurrences.some(sameMention)
        )
          superseded = true;
      }
      if (
        !superseded &&
        !existing.occurrences.some(
          (o) => occurrenceKey(o) === occurrenceKey(occurrence),
        )
      )
        existing.occurrences.push(occurrence);
    }
  }
  for (let i = target.length - 1; i >= 0; i--)
    if (!target[i].occurrences.length) target.splice(i, 1);
  target.sort(
    (a, b) =>
      (a.occurrences[0]?.origin === 'notes' ? 1 : 0) -
        (b.occurrences[0]?.origin === 'notes' ? 1 : 0) ||
      a.occurrences[0]?.startMs - b.occurrences[0]?.startMs,
  );
}
function boundedOccurrence(occurrence: SourceOccurrence, window: SourceWindow) {
  if (Array.from(occurrence.mention).length > 450 || !occurrence.spans.length)
    return false;
  if (window.origin === 'notes') return true;
  const first = occurrence.spans[0].segmentIndex,
    last = occurrence.spans.at(-1)!.segmentIndex;
  if (
    !window.units[first] ||
    !window.units[last] ||
    window.units[last].startMs - window.units[first].startMs > 60000
  )
    return false;
  for (let i = first + 1; i <= last; i++)
    if (window.units[i].startMs - window.units[i - 1].endMs > 15000)
      return false;
  return true;
}

function hasRequiredSection(ref: string, mention: string) {
  if (
    !/^(?:Shulchan Arukh|Tur|Beit Yosef|Turei Zahav on Shulchan Arukh),/u.test(
      ref,
    )
  )
    return true;
  const plain = mention
    .normalize('NFKD')
    .replace(/[\u0591-\u05bd\u05bf-\u05c7]/gu, '');
  const parts: Array<[string, RegExp]> = [
    [
      'Orach Chayim',
      /(?:o(?:r|ra)ch\s+ch(?:ayim|aim|ay[i]?m)|[ao]r(?:a|au)?ch\s+cha[iy]m|auruch\s+chaim|אורח\s+חיים|או[״"׳']ח)/iu,
    ],
    ["Yoreh De'ah", /(?:yoreh?\s+d[ei][ae]h?|יורה\s+דעה|יו[״"׳']ד)/iu],
    ['Even HaEzer', /(?:even\s+(?:ha\s*)?e[sz]er|אבן\s+העזר|אה[״"׳']ע)/iu],
    ['Choshen Mishpat', /(?:chosh[ae]n\s+mishp[ao]t|חושן\s+משפט|חו[״"׳']מ)/iu],
  ];
  return parts.some(
    ([name, pattern]) => ref.includes(', ' + name + ' ') && pattern.test(plain),
  );
}
function mapWindow(result: WindowResult, window: SourceWindow): WindowResult {
  return {
    ...result,
    sources: result.sources.map((source) => ({
      ...source,
      occurrences: source.occurrences.map((o) => {
        const spans = o.spans.map((span) => ({
          ...span,
          text: window.units[span.segmentIndex].text.slice(
            span.startChar,
            span.endChar,
          ),
          segmentIndex: window.units[span.segmentIndex].segmentIndex,
          startChar:
            span.startChar + window.units[span.segmentIndex].charOffset,
          endChar: span.endChar + window.units[span.segmentIndex].charOffset,
        }));
        const first = o.spans[0];
        const offset =
          window.units[first.segmentIndex].offset + first.startChar;
        return {
          ...o,
          origin: window.origin,
          offset,
          spans: window.origin === 'transcript' ? spans : [],
          ...(window.origin === 'notes'
            ? {
                noteSpans: o.spans.map((span) => ({
                  startChar:
                    window.units[span.segmentIndex].offset + span.startChar,
                  endChar:
                    window.units[span.segmentIndex].offset + span.endChar,
                })),
              }
            : {}),
        };
      }),
    })),
    reviews: result.reviews.map((r) => ({
      ...r,
      id: `${window.origin}:${window.units[0].offset}:${r.id}`,
    })),
  };
}
function quoteOccurrence(
  text: string,
  start: number,
  end: number,
  window: SourceWindow,
): SourceOccurrence | null {
  const spans: SourceOccurrence['spans'] = [];
  let offset = 0;
  window.units.forEach((unit, segmentIndex) => {
    const left = Math.max(start, offset),
      right = Math.min(end, offset + unit.text.length);
    if (right > left)
      spans.push({
        segmentIndex,
        startChar: left - offset,
        endChar: right - offset,
      });
    offset += unit.text.length + 2;
  });
  return spans.length
    ? {
        offset: Array.from(text.slice(0, start)).length,
        startMs: window.units[spans[0].segmentIndex].startMs,
        endMs: window.units[spans.at(-1)!.segmentIndex].endMs,
        mention: text.slice(start, end),
        spans,
      }
    : null;
}
function addQuoteReview(
  result: WindowResult,
  review: QuoteReview,
  mention: string,
  occurrence: SourceOccurrence,
  window: SourceWindow,
) {
  const id = `quote:${occurrence.offset}:${review.reason}`;
  if (result.reviews.some((existing) => existing.id === id)) return;
  result.reviews.push({
    ...review,
    mention: mention.slice(0, 240),
    origin: window.origin,
    startMs: occurrence.startMs,
    id,
  });
}
