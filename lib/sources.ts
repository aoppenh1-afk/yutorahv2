import type { SearchDatabase } from './search-storage';
import {
  findRefs,
  pollRefs,
  refMetadata,
  sefariaUrl,
  SefariaTaskError,
  type LinkerBody,
  type RefMetadata,
  type SefariaFetch,
} from './sefaria';
import { spokenCitations } from './spoken-sources';

export type SourceTranscript = {
  transcriptId: string;
  searchVersion?: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
};
export type SourceOccurrence = {
  offset: number;
  startMs: number;
  endMs: number;
  mention: string;
  spans: Array<{
    segmentIndex: number;
    startChar: number;
    endChar: number;
    text?: string;
  }>;
  origin?: 'transcript' | 'notes' | 'description' | 'manual';
  method?: 'citation' | 'quotation';
  noteSpans?: Array<{ startChar: number; endChar: number }>;
  verification?: string;
};
export type TranscriptSource = {
  ref: string;
  heRef: string;
  url: string;
  category: string;
  occurrences: SourceOccurrence[];
};
export type SourcesResult = {
  transcriptId: string;
  status: 'pending' | 'ready';
  progress: number;
  sources: TranscriptSource[];
  omitted: number;
  omissionCounts: Partial<Record<OmissionReason, number>>;
  omissions: SourceOmission[];
  limited: boolean;
  waiting?: boolean;
};
export type OmissionReason =
  | 'unresolved'
  | 'ambiguous'
  | 'inferred'
  | 'missing_location'
  | 'missing_amud'
  | 'missing_comment'
  | 'incomplete_range'
  | 'partial_commentary'
  | 'invalid_match'
  | 'limit';
export type SourceOmission = {
  reason: OmissionReason;
  mention: string;
  offset: number;
  startMs: number;
};
type Candidate = {
  ref: string;
  category: string;
  occurrence: SourceOccurrence;
  language?: 'en' | 'he' | 'spoken';
};
type State = {
  cursor: number;
  language: number;
  task: { id: string; started: number } | null;
  candidates: Candidate[];
  proposals: Candidate[];
  proposedOmissions: SourceOmission[];
  metadata: Record<string, RefMetadata | null>;
  sources: TranscriptSource[];
  omitted: number;
  omissionCounts: SourcesResult['omissionCounts'];
  omissions: SourceOmission[];
  omissionKeys: string[];
  limited: boolean;
  done: boolean;
};
export type SourceDetectionSession = { state?: State };
type Row = { payload: string; lease: number; expires: number };
const policyVersion = 7;
const chunkSize = 12000;
const overlap = 512;
const cacheDuration = 30 * 24 * 60 * 60 * 1000;

export class SourcesLimitError extends Error {}
export class SourcesLeaseError extends Error {}

type Prepared = { key: string; chars: string[]; segmentOffsets: number[] };
const prepared = new WeakMap<SourceTranscript, Promise<Prepared>>();
async function prepare(transcript: SourceTranscript): Promise<Prepared> {
  const previous = prepared.get(transcript);
  if (previous) return previous;
  const work = (async () => {
    validateSourceTranscript(transcript);
    const chars = Array.from(
      transcript.segments.map((s) => s.text).join('\n\n'),
    );
    const key = transcript.searchVersion
      ? sourcesResultKey(transcript.transcriptId, transcript.searchVersion)
      : Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(
                JSON.stringify({
                  policyVersion,
                  transcriptId: transcript.transcriptId,
                  segments: transcript.segments,
                }),
              ),
            ),
          ),
          (n) => n.toString(16).padStart(2, '0'),
        ).join('');
    let offset = 0;
    const segmentOffsets = transcript.segments.map((s) => {
      const start = offset;
      offset += Array.from(s.text).length + 2;
      return start;
    });
    return {
      chars,
      segmentOffsets,
      key,
    };
  })();
  prepared.set(transcript, work);
  return work;
}
export function sourcesResultKey(transcriptId: string, searchVersion: string) {
  return `sources:v${policyVersion}:${transcriptId}:${searchVersion}`;
}
/** The version is obtained from published status, never trusted from a client. */
export async function cachedSourcesResult(
  db: SearchDatabase,
  transcriptId: string,
  searchVersion: string,
): Promise<SourcesResult | null> {
  const row = await db
    .prepare('SELECT payload FROM sources_runs WHERE id=? AND expires>?')
    .bind(sourcesResultKey(transcriptId, searchVersion), Date.now())
    .first<{ payload: string }>();
  if (!row) return null;
  const state = JSON.parse(row.payload) as State;
  return state.done
    ? {
        transcriptId,
        status: 'ready',
        progress: 100,
        sources: state.sources,
        omitted: state.omitted,
        omissionCounts: state.omissionCounts,
        omissions: state.omissions,
        limited: state.limited,
      }
    : null;
}

export function validateSourceTranscript(transcript: SourceTranscript) {
  if (
    !transcript?.transcriptId ||
    !Array.isArray(transcript.segments) ||
    transcript.segments.some(
      (s) =>
        typeof s.text !== 'string' ||
        !Number.isSafeInteger(s.startMs) ||
        !Number.isSafeInteger(s.endMs) ||
        s.startMs < 0 ||
        s.endMs < s.startMs,
    )
  )
    throw new Error('The transcript is not ready for sources.');
  if (
    transcript.segments.length > 100000 ||
    transcript.segments.reduce((n, s) => n + s.text.length + 2, 0) > 2_000_000
  )
    throw new SourcesLimitError(
      'This transcript is too large to check for sources.',
    );
}

/** All progress lives in SQL. Each call completes one bounded pass, never a background promise. */
export async function advanceSources(
  db: SearchDatabase,
  transcript: SourceTranscript,
  fetcher: SefariaFetch = fetch,
  session?: SourceDetectionSession,
): Promise<SourcesResult> {
  const { key, chars, segmentOffsets } = await prepare(transcript);
  const now = Date.now();
  const initial: State = {
    cursor: 0,
    language: 0,
    task: null,
    candidates: [],
    proposals: [],
    proposedOmissions: [],
    metadata: {},
    sources: [],
    omitted: 0,
    omissionCounts: {},
    omissions: [],
    omissionKeys: [],
    limited: false,
    done: transcript.segments.every((s) => !s.text.trim()),
  };
  const existing = session
    ? session.state
      ? {
          payload: JSON.stringify(session.state),
          lease: 0,
          expires: now + cacheDuration,
        }
      : null
    : await db
        .prepare(
          'SELECT payload,lease,expires FROM sources_runs WHERE id = ? AND expires > ?',
        )
        .bind(key, now)
        .first<Row>();
  if (session && !session.state) session.state = initial;
  if (!session && !existing) {
    await db
      .prepare(
        'DELETE FROM sources_runs WHERE id = ? AND expires < ? AND lease < ?',
      )
      .bind(key, now, now)
      .run();
    await db
      .prepare(
        'INSERT INTO sources_runs (id,payload,lease,expires) VALUES (?,?,0,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(key, JSON.stringify(initial), now + cacheDuration)
      .run();
  }
  const read = async () => {
    if (session) return structuredClone(session.state!);
    const row = await db
      .prepare('SELECT payload,lease,expires FROM sources_runs WHERE id = ?')
      .bind(key)
      .first<Row>();
    if (!row) throw new Error('Sources could not be saved.');
    return JSON.parse(row.payload) as State;
  };
  const reply = (state: State): SourcesResult => ({
    transcriptId: transcript.transcriptId,
    status: state.done ? 'ready' : 'pending',
    progress: state.done
      ? 100
      : Math.min(
          99,
          Math.floor((state.cursor / Math.max(1, chars.length)) * 100),
        ),
    sources: state.sources,
    omitted: state.omitted,
    omissionCounts: state.omissionCounts,
    omissions: state.omissions,
    limited: state.limited,
    waiting: !!state.task,
  });
  const cached = existing
    ? (JSON.parse(existing.payload) as State)
    : await read();
  if (cached.done) return reply(cached);
  const lease = now + 60000;
  const claimed = session
    ? { meta: { changes: 1 } }
    : await db
        .prepare('UPDATE sources_runs SET lease = ? WHERE id = ? AND lease < ?')
        .bind(lease, key, now)
        .run();
  if (!claimed.meta.changes) return reply(await read());
  try {
    const state = await read();
    if (state.candidates.length) {
      const candidates = state.candidates.slice(0, 4);
      const refs = [...new Set(candidates.map((c) => c.ref))];
      const checkedRefs = await Promise.allSettled(
        refs.map(async (ref) => ({
          ref,
          meta: Object.hasOwn(state.metadata, ref)
            ? state.metadata[ref]
            : await refMetadata(ref, fetcher),
        })),
      );
      const failed = candidates.filter(
        (c) => checkedRefs[refs.indexOf(c.ref)].status === 'rejected',
      );
      if (failed.length === candidates.length) {
        const failure = checkedRefs.find(
          (result) => result.status === 'rejected',
        )!;
        throw failure.reason;
      }
      const checked = candidates.flatMap((c) => {
        const result = checkedRefs[refs.indexOf(c.ref)];
        return result.status === 'fulfilled'
          ? [{ c, meta: result.value.meta }]
          : [];
      });
      for (const { c, meta } of checked) {
        if (
          !Object.hasOwn(state.metadata, c.ref) &&
          Object.keys(state.metadata).length >= 200
        )
          delete state.metadata[Object.keys(state.metadata)[0]];
        state.metadata[c.ref] = meta;
        const url = meta && sefariaUrl(meta.url_ref);
        const reason =
          !meta || !url
            ? 'unresolved'
            : c.language === 'spoken' && meta.normalized !== c.ref
              ? 'invalid_match'
              : specificityReason(
                  meta,
                  c.language === 'spoken' ? c.ref : c.occurrence.mention,
                );
        if (reason || !meta || !url) {
          omit(state, { ...c.occurrence, reason: reason || 'unresolved' });
          continue;
        }
        let source = state.sources.find((s) => s.ref === meta.normalized);
        if (!source) {
          if (state.sources.length >= 100) {
            state.limited = true;
            omit(state, { ...c.occurrence, reason: 'limit' });
            continue;
          }
          source = {
            ref: meta.normalized,
            heRef: meta.hebrew,
            url,
            category: c.category,
            occurrences: [],
          };
          state.sources.push(source);
        }
        if (
          source.occurrences.length >= 50 ||
          state.sources.reduce((n, s) => n + s.occurrences.length, 0) >= 300
        ) {
          state.limited = true;
          omit(state, { ...c.occurrence, reason: 'limit' });
        } else if (
          !source.occurrences.some((o) => o.offset === c.occurrence.offset)
        )
          source.occurrences.push(c.occurrence);
      }
      state.candidates.splice(0, candidates.length);
      // One unavailable ref must not discard the verified refs from the same pass.
      // Retry failed refs after the remaining candidates, with the usual upstream backoff.
      state.candidates.push(...failed);
    } else if (state.cursor < chars.length || state.task) {
      const start = state.cursor;
      let end = Math.min(chars.length, start + chunkSize);
      if (end < chars.length) {
        const chunk = chars.slice(start, end).join('');
        const boundary = chunk.lastIndexOf('\n\n');
        if (boundary > chunkSize / 2)
          end = start + Array.from(chunk.slice(0, boundary)).length;
      }
      const chunk = chars.slice(start, end).join('');
      const languages: Array<'en' | 'he'> = [];
      if (/[a-z]/i.test(chunk)) languages.push('en');
      if (/[\u05d0-\u05ea]/u.test(chunk)) languages.push('he');
      if (!languages.length) languages.push('en');
      let body: LinkerBody | null;
      if (state.task) {
        if (now - state.task.started > 5 * 60 * 1000) {
          state.task = null;
          await save(state);
          throw new Error('Sefaria took too long. Retry to start a new check.');
        }
        try {
          body = await pollRefs(state.task.id, fetcher);
        } catch (error) {
          if (error instanceof SefariaTaskError) {
            state.task = null;
            await save(state);
          }
          throw error;
        }
      } else {
        const found = await findRefs(chunk, fetcher, languages[state.language]);
        state.task = found.taskId ? { id: found.taskId, started: now } : null;
        body = found.body;
      }
      if (body) {
        const found = candidatesFrom(
          body,
          chars,
          start,
          end,
          transcript,
          segmentOffsets,
        );
        for (const candidate of found.candidates)
          candidate.language = languages[state.language];
        state.proposals.push(...found.candidates);
        state.proposedOmissions.push(...found.omissions);
        state.task = null;
        state.language++;
        if (state.language >= languages.length) {
          const spoken = spokenCitations(chunk).flatMap(
            (citation): Candidate[] => {
              const from =
                start + Array.from(chunk.slice(0, citation.start)).length;
              const to =
                start + Array.from(chunk.slice(0, citation.end)).length;
              const occurrence = sourceOccurrence(
                chars,
                from,
                to,
                transcript,
                segmentOffsets,
                citation.ranges.map((range) => ({
                  start: start + Array.from(chunk.slice(0, range.start)).length,
                  end: start + Array.from(chunk.slice(0, range.end)).length,
                })),
              );
              if (!occurrence) return [];
              const firstSegment = occurrence.spans[0].segmentIndex;
              const lastSegment = occurrence.spans.at(-1)!.segmentIndex;
              if (
                transcript.segments[lastSegment].startMs -
                  transcript.segments[firstSegment].startMs >
                120000
              )
                return [];
              for (let i = firstSegment + 1; i <= lastSegment; i++)
                if (
                  transcript.segments[i].startMs -
                    transcript.segments[i - 1].endMs >
                  30000
                )
                  return [];
              // Retain genuine model disagreements. Only replace an agreeing parse or a default amud.
              const matching = state.proposals.filter((candidate) =>
                overlaps(candidate.occurrence, occurrence),
              );
              if (
                matching.some(
                  (candidate) =>
                    candidate.ref !== citation.ref &&
                    candidate.ref.replace(/(\d+)[ab]$/u, '$1') !==
                      citation.ref &&
                    !(
                      citation.category === 'Commentary' &&
                      candidate.category !== 'Commentary' &&
                      occurrence.offset < candidate.occurrence.offset
                    ),
                )
              )
                return [];
              // A more precise linker span includes the entire spoken reference.
              if (
                matching.some(
                  (candidate) =>
                    candidate.ref === citation.ref &&
                    candidate.occurrence.offset <= from &&
                    candidate.occurrence.offset +
                      Array.from(candidate.occurrence.mention).length >=
                      to,
                )
              )
                return [];
              state.proposals = state.proposals.filter(
                (candidate) => !matching.includes(candidate),
              );
              return [
                {
                  ref: citation.ref,
                  category: citation.category,
                  occurrence,
                  language: 'spoken',
                },
              ];
            },
          );
          state.proposals.push(...spoken);
          // A disagreement between models at the same citation is ambiguous.
          const proposals = state.proposals;
          state.candidates = proposals.filter((candidate, index) => {
            const conflicted = proposals.some(
              (other) =>
                other.language !== candidate.language &&
                other.ref !== candidate.ref &&
                other.occurrence.offset <
                  candidate.occurrence.offset +
                    Array.from(candidate.occurrence.mention).length &&
                candidate.occurrence.offset <
                  other.occurrence.offset +
                    Array.from(other.occurrence.mention).length,
            );
            if (conflicted) {
              omit(state, { ...candidate.occurrence, reason: 'ambiguous' });
              return false;
            }
            return !proposals
              .slice(0, index)
              .some(
                (other) =>
                  other.ref === candidate.ref &&
                  other.occurrence.offset === candidate.occurrence.offset,
              );
          });
          // A failed parse in one model is not an omission when the other model verified the same words.
          for (const omission of state.proposedOmissions) {
            if (
              !proposals.some(
                (candidate) =>
                  candidate.occurrence.offset <
                    omission.offset + Array.from(omission.mention).length &&
                  omission.offset <
                    candidate.occurrence.offset +
                      Array.from(candidate.occurrence.mention).length,
              )
            )
              omit(state, omission);
          }
          state.proposedOmissions = [];
          state.proposals = [];
          state.language = 0;
          state.cursor = end === chars.length ? end : end - overlap;
        }
      }
    }
    state.done =
      state.cursor >= chars.length && !state.task && !state.candidates.length;
    for (const source of state.sources)
      source.occurrences.sort((a, b) => a.offset - b.offset);
    state.sources.sort(
      (a, b) => a.occurrences[0].offset - b.occurrences[0].offset,
    );
    await save(state);
    return reply(state);
  } finally {
    if (!session)
      await db
        .prepare('UPDATE sources_runs SET lease = 0 WHERE id = ? AND lease = ?')
        .bind(key, lease)
        .run();
  }
  async function save(state: State) {
    if (session) {
      session.state = structuredClone(state);
      return;
    }
    const payload = JSON.stringify(
      state.done
        ? {
            ...state,
            metadata: {},
            candidates: [],
            proposals: [],
            proposedOmissions: [],
            omissionKeys: [],
            task: null,
          }
        : state,
    );
    if (new TextEncoder().encode(payload).length > 900000)
      throw new SourcesLimitError(
        'Too many citations to save. This transcript needs a smaller sources run.',
      );
    const saved = await db
      .prepare(
        'UPDATE sources_runs SET payload = ?, expires = ? WHERE id = ? AND lease = ? AND lease > ?',
      )
      .bind(payload, Date.now() + cacheDuration, key, lease, Date.now())
      .run();
    if (!saved.meta.changes)
      throw new SourcesLeaseError(
        'Sources processing ownership changed. Retry to continue.',
      );
  }
}

function omit(state: State, omission: SourceOmission) {
  const key = `${omission.offset}:${omission.reason}`;
  if (state.omissionKeys.includes(key)) return;
  if (state.omissionKeys.length < 2000) state.omissionKeys.push(key);
  if (omission.reason === 'limit') state.limited = true;
  state.omitted++;
  state.omissionCounts[omission.reason] =
    (state.omissionCounts[omission.reason] || 0) + 1;
  if (state.omissions.length < 50)
    state.omissions.push({
      reason: omission.reason,
      offset: omission.offset,
      mention: omission.mention.slice(0, 160),
      startMs: omission.startMs,
    });
}

function specificityReason(
  meta: RefMetadata,
  mention: string,
): OmissionReason | null {
  if (meta.node_type !== 'JaggedArrayNode') return 'unresolved';
  const talmud = meta.address_types[0] === 'Talmud';
  // A cited chapter, siman, daf or commentary page is useful at the detail actually spoken.
  const required = 1;
  if (
    required < 1 ||
    meta.start_indexes.length < required ||
    meta.end_indexes.length < required
  )
    return 'missing_location';
  if (talmud) {
    const markers = [
      ...mention.matchAll(
        /(?:\d+\s*([ab])\b|(?:עמוד\s*|ע[״"'׳’]?\s*)([אב])|amud\s+(a\b|b\b|aleph|alef|beis|bet|bais)|דף\s+[0-9א-ת״"'׳]+\s*([:.]))/giu,
      ),
    ];
    if (
      !/^\d+[ab]$/.test(meta.start_labels[0]) ||
      !/^\d+[ab]$/.test(meta.end_labels[0])
    )
      return 'missing_amud';
    if (!markers.length) {
      // The whole daf must contain both sides, never a side supplied by the linker.
      const range = meta.normalized.match(/\s(\d+)(?:-(\d+))?$/u);
      return range &&
        meta.start_labels[0] === range[1] + 'a' &&
        meta.end_labels[0] === (range[2] || range[1]) + 'b' &&
        meta.start_labels[0].endsWith('a') &&
        meta.end_labels[0].endsWith('b')
        ? null
        : 'missing_amud';
    }
    const sides = markers.map((m) => {
      const side = (
        m[1] ||
        m[2] ||
        m[3] ||
        (m[4] === '.' ? 'a' : 'b')
      ).toLowerCase();
      return ['a', 'א', 'aleph', 'alef'].includes(side) ? 'a' : 'b';
    });
    const ranged = meta.start_labels[0] !== meta.end_labels[0];
    if (ranged && markers.length < 2) return 'incomplete_range';
    if (
      sides[0] !== meta.start_labels[0].slice(-1) ||
      sides.at(-1) !== meta.end_labels[0].slice(-1)
    )
      return ranged ? 'incomplete_range' : 'invalid_match';
    // Numeric shorthand must also name the same daf as the canonical endpoint.
    const numeric = [...mention.matchAll(/(\d+)\s*([ab])\b/giu)].map(
      (m) => m[1] + m[2].toLowerCase(),
    );
    if (numeric.length && numeric[0] !== meta.start_labels[0])
      return 'invalid_match';
    if (ranged && numeric.length && numeric.at(-1) !== meta.end_labels[0])
      return 'incomplete_range';
  }
  return null;
}

function candidatesFrom(
  body: LinkerBody,
  chars: string[],
  start: number,
  end: number,
  transcript: SourceTranscript,
  segmentOffsets: number[],
) {
  const candidates: Candidate[] = [];
  const omissions: SourceOmission[] = [];
  const segmentAt = (offset: number) => {
    let left = 0,
      right = segmentOffsets.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (segmentOffsets[middle] <= offset) left = middle + 1;
      else right = middle;
    }
    return Math.max(0, left - 1);
  };
  for (const [index, result] of body.results.entries()) {
    const debug = body.debugData[index];
    const validSpan =
      result &&
      Number.isSafeInteger(result.startChar) &&
      Number.isSafeInteger(result.endChar) &&
      result.startChar >= 0 &&
      result.endChar > result.startChar &&
      result.endChar <= end - start &&
      result.endChar - result.startChar <= 500;
    const from = validSpan ? start + result.startChar : start;
    const to = validSpan ? start + result.endChar : start;
    const mention = validSpan ? chars.slice(from, to).join('') : '';
    const reject = (reason: OmissionReason) =>
      omissions.push({
        reason,
        mention,
        offset: from,
        startMs: transcript.segments[segmentAt(from)]?.startMs || 0,
      });
    if (!validSpan || mention !== result.text) {
      reject('invalid_match');
      continue;
    }
    if (
      result.linkFailed !== false ||
      !Array.isArray(result.refs) ||
      !result.refs.length
    ) {
      reject('unresolved');
      continue;
    }
    if (result.refs.length !== 1) {
      reject('ambiguous');
      continue;
    }
    if (
      !Array.isArray(debug) ||
      !debug.length ||
      debug.some(
        (d) =>
          !d ||
          !Array.isArray(d.resolved_part_classes) ||
          !d.resolved_part_classes.length ||
          !Array.isArray(d.orig_part_types),
      )
    ) {
      reject('invalid_match');
      continue;
    }
    if (
      debug.some(
        (d) =>
          d.context_ref !== null ||
          d.context_type !== null ||
          d.resolved_part_classes.some((c) => c !== 'RawRefPart') ||
          d.orig_part_types.includes('IBID'),
      )
    ) {
      reject('inferred');
      continue;
    }
    if (
      debug.some(
        (d) =>
          !d.orig_part_types.includes('NAMED') ||
          !d.orig_part_types.includes('NUMBERED'),
      )
    ) {
      reject('invalid_match');
      continue;
    }
    const ref = result.refs[0];
    const data = body.refData[ref];
    if (
      typeof ref !== 'string' ||
      !data ||
      typeof data.primaryCategory !== 'string'
    ) {
      reject('invalid_match');
      continue;
    }
    if (
      /^(?:Shulchan Arukh,|Tur,|Beit Yosef,)/u.test(ref) &&
      !/(?:\bshulch[ao]n\s+(?:aruch|arukh|oruch)|שולחן\s+ערוך|שו[״"׳']ע|\btur\b|טור|bei[st]\s+yose[fp]h?|בית\s+יוסף)/iu.test(
        mention,
      )
    ) {
      // A section name such as Orach Chayim alone does not identify its author/work.
      // Nearby explicit names can still be recovered by the spoken citation pass.
      reject('inferred');
      continue;
    }
    const prefix = chars.slice(Math.max(start, from - 100), from).join('');
    // Only inspect the immediately preceding phrase, not an earlier sentence's commentator.
    const phrase = prefix.split(/[.!?;\n]/u).at(-1)!;
    if (
      data.primaryCategory !== 'Commentary' &&
      /(?:\b(?:tos(?:afot|afos|fos|fot)|rashi|ramban|rashba|ritva|ran|rosh|maharsha)|תוספות|תוס[׳״']|רש[״"׳']י|רמב[״"׳']ן|רשב[״"׳']א|ריטב[״"׳']א)(?:[’']s)?(?:\s+(?:comment(?:ary)?|comments|explanation|says|writes|on|in|the|gemara|of)|\s+(?:על|אומר|אומרים|בגמרא|במסכת))*[\s,:—-]*$/iu.test(
        phrase,
      )
    ) {
      reject('partial_commentary');
      continue;
    }
    if (candidates.length >= 128) {
      reject('limit');
      continue;
    }
    const occurrence = sourceOccurrence(
      chars,
      from,
      to,
      transcript,
      segmentOffsets,
    );
    if (!occurrence) {
      reject('invalid_match');
      continue;
    }
    candidates.push({ ref, category: data.primaryCategory, occurrence });
  }
  return { candidates, omissions };
}

function overlaps(a: SourceOccurrence, b: SourceOccurrence) {
  return (
    a.offset < b.offset + Array.from(b.mention).length &&
    b.offset < a.offset + Array.from(a.mention).length
  );
}

function sourceOccurrence(
  chars: string[],
  from: number,
  to: number,
  transcript: SourceTranscript,
  segmentOffsets: number[],
  ranges = [{ start: from, end: to }],
): SourceOccurrence | null {
  const spans: SourceOccurrence['spans'] = [];
  let startMs = 0,
    endMs = 0;
  let left = 0,
    right = segmentOffsets.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (segmentOffsets[middle] <= from) left = middle + 1;
    else right = middle;
  }
  for (
    let segmentIndex = Math.max(0, left - 1);
    segmentIndex < transcript.segments.length &&
    segmentOffsets[segmentIndex] < to;
    segmentIndex++
  ) {
    const segment = transcript.segments[segmentIndex];
    const points = chars.slice(
      segmentOffsets[segmentIndex],
      segmentOffsets[segmentIndex] + Array.from(segment.text).length,
    );
    const base = segmentOffsets[segmentIndex];
    for (const range of ranges) {
      const left = Math.max(range.start, base),
        right = Math.min(range.end, base + points.length);
      if (right <= left) continue;
      if (!spans.length) startMs = segment.startMs;
      endMs = segment.endMs;
      spans.push({
        segmentIndex,
        startChar: points.slice(0, left - base).join('').length,
        endChar: points.slice(0, right - base).join('').length,
      });
    }
  }
  return spans.length
    ? {
        offset: from,
        startMs,
        endMs,
        mention: chars.slice(from, to).join(''),
        spans,
      }
    : null;
}
