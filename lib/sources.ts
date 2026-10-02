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

export type SourceTranscript = {
  transcriptId: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
};
export type SourceOccurrence = {
  offset: number;
  startMs: number;
  endMs: number;
  mention: string;
  spans: Array<{ segmentIndex: number; startChar: number; endChar: number }>;
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
  limited: boolean;
};
type Candidate = {
  ref: string;
  category: string;
  occurrence: SourceOccurrence;
  language?: 'en' | 'he';
};
type State = {
  cursor: number;
  language: number;
  task: { id: string; started: number } | null;
  candidates: Candidate[];
  proposals: Candidate[];
  metadata: Record<string, RefMetadata | null>;
  sources: TranscriptSource[];
  omitted: number;
  limited: boolean;
  done: boolean;
};
type Row = { payload: string; lease: number; expires: number };
const policyVersion = 2;
const chunkSize = 12000;
const overlap = 256;
const cacheDuration = 7 * 24 * 60 * 60 * 1000;

export class SourcesLimitError extends Error {}

/** All progress lives in SQL. Each call completes one bounded pass, never a background promise. */
export async function advanceSources(
  db: SearchDatabase,
  transcript: SourceTranscript,
  fetcher: SefariaFetch = fetch,
): Promise<SourcesResult> {
  if (
    !transcript.transcriptId ||
    !Array.isArray(transcript.segments) ||
    transcript.segments.some(
      (s) =>
        typeof s.text !== 'string' ||
        !Number.isSafeInteger(s.startMs) ||
        !Number.isSafeInteger(s.endMs),
    )
  )
    throw new Error('The transcript is not ready for sources.');
  const text = transcript.segments.map((s) => s.text).join('\n\n');
  if (text.length > 2_000_000 || transcript.segments.length > 100000)
    throw new SourcesLimitError(
      'This transcript is too large to check for sources.',
    );
  const chars = Array.from(text); // Sefaria uses Python Unicode character offsets, not UTF-16.
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({
        policyVersion,
        transcriptId: transcript.transcriptId,
        segments: transcript.segments,
      }),
    ),
  );
  const key = Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
  const now = Date.now();
  const initial: State = {
    cursor: 0,
    language: 0,
    task: null,
    candidates: [],
    proposals: [],
    metadata: {},
    sources: [],
    omitted: 0,
    limited: false,
    done: !text.trim(),
  };
  await db
    .prepare('DELETE FROM sources_runs WHERE expires < ? AND lease < ?')
    .bind(now, now)
    .run();
  await db
    .prepare(
      'INSERT INTO sources_runs (id,payload,lease,expires) VALUES (?,?,0,?) ON CONFLICT(id) DO NOTHING',
    )
    .bind(key, JSON.stringify(initial), now + cacheDuration)
    .run();
  const read = async () => {
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
    limited: state.limited,
  });
  const cached = await read();
  if (cached.done) return reply(cached);
  const lease = now + 60000;
  const claimed = await db
    .prepare('UPDATE sources_runs SET lease = ? WHERE id = ? AND lease < ?')
    .bind(lease, key, now)
    .run();
  if (!claimed.meta.changes) return reply(await read());
  try {
    const state = await read();
    if (state.candidates.length) {
      const candidates = state.candidates.slice(0, 4);
      const refs = [...new Set(candidates.map((c) => c.ref))];
      const checkedRefs = await Promise.all(
        refs.map(async (ref) => ({
          ref,
          meta: Object.hasOwn(state.metadata, ref)
            ? state.metadata[ref]
            : await refMetadata(ref, fetcher),
        })),
      );
      const checked = candidates.map((c) => ({
        c,
        meta: checkedRefs.find((item) => item.ref === c.ref)!.meta,
      }));
      for (const { c, meta } of checked) {
        state.metadata[c.ref] = meta;
        const url = meta && sefariaUrl(meta.url_ref);
        if (
          !meta ||
          !url ||
          !specificEnough(meta, c.category, c.occurrence.mention)
        ) {
          state.omitted++;
          continue;
        }
        let source = state.sources.find((s) => s.ref === meta.normalized);
        if (!source) {
          if (state.sources.length >= 100) {
            state.limited = true;
            state.omitted++;
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
        if (!source.occurrences.some((o) => o.offset === c.occurrence.offset))
          source.occurrences.push(c.occurrence);
      }
      state.candidates.splice(0, candidates.length);
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
        const found = candidatesFrom(body, chars, start, end, transcript);
        for (const candidate of found.candidates)
          candidate.language = languages[state.language];
        state.proposals.push(...found.candidates);
        state.omitted += found.omitted;
        state.task = null;
        state.language++;
        if (state.language >= languages.length) {
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
              state.omitted++;
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
    await db
      .prepare('UPDATE sources_runs SET lease = 0 WHERE id = ? AND lease = ?')
      .bind(key, lease)
      .run();
  }
  async function save(state: State) {
    await db
      .prepare(
        'UPDATE sources_runs SET payload = ?, expires = ? WHERE id = ? AND lease = ?',
      )
      .bind(JSON.stringify(state), Date.now() + cacheDuration, key, lease)
      .run();
  }
}

function specificEnough(meta: RefMetadata, category: string, mention: string) {
  if (meta.node_type !== 'JaggedArrayNode') return false;
  const talmud = meta.address_types[0] === 'Talmud';
  // A daf+amud is useful. Commentary additionally needs an individual entry;
  // Tosafot's third dimension can be paragraphs inside the cited comment.
  const required = talmud
    ? category === 'Commentary'
      ? Math.max(2, meta.depth - 1)
      : 1
    : meta.depth;
  if (
    required < 1 ||
    meta.start_indexes.length < required ||
    meta.end_indexes.length < required
  )
    return false;
  if (
    talmud &&
    (!/(?:\d+\s*[ab]\b|(?:עמוד\s*|ע[״"'׳’]?\s*)[אב]|amud\s+(?:[ab]\b|aleph|alef|beis|bet|bais))/iu.test(
      mention,
    ) ||
      !/^\d+[ab]$/.test(meta.start_labels[0]) ||
      !/^\d+[ab]$/.test(meta.end_labels[0]))
  )
    return false;
  return true;
}

function candidatesFrom(
  body: LinkerBody,
  chars: string[],
  start: number,
  end: number,
  transcript: SourceTranscript,
) {
  const candidates: Candidate[] = [];
  let omitted = 0;
  const segmentOffsets: number[] = [];
  let offset = 0;
  for (const s of transcript.segments) {
    segmentOffsets.push(offset);
    offset += Array.from(s.text).length + 2;
  }
  for (const [index, result] of body.results.entries()) {
    const debug = body.debugData[index];
    if (
      !result ||
      result.linkFailed !== false ||
      !Array.isArray(result.refs) ||
      result.refs.length !== 1 ||
      !Array.isArray(debug) ||
      !debug.length ||
      debug.some(
        (d) =>
          !d ||
          d.context_ref !== null ||
          d.context_type !== null ||
          !Array.isArray(d.resolved_part_classes) ||
          d.resolved_part_classes.some((c) => c !== 'RawRefPart') ||
          !Array.isArray(d.orig_part_types) ||
          d.orig_part_types.includes('IBID'),
      ) ||
      !Number.isSafeInteger(result.startChar) ||
      !Number.isSafeInteger(result.endChar) ||
      result.startChar < 0 ||
      result.endChar <= result.startChar ||
      result.endChar > end - start ||
      result.endChar - result.startChar > 500
    ) {
      omitted++;
      continue;
    }
    const from = start + result.startChar;
    const to = start + result.endChar;
    const mention = chars.slice(from, to).join('');
    const ref = result.refs[0];
    const data = body.refData[ref];
    if (
      typeof ref !== 'string' ||
      !data ||
      typeof data.primaryCategory !== 'string' ||
      mention !== result.text
    ) {
      omitted++;
      continue;
    }
    // Don't turn a partially recognized "Tosfos on Shabbat 2b" into a Gemara link.
    const prefix = chars.slice(Math.max(start, from - 60), from).join('');
    if (
      data.primaryCategory !== 'Commentary' &&
      /(?:\b(?:tos(?:afot|afos|fos|fot)|rashi|ramban)|תוספות|תוס׳|רש[״"]י)\s+(?:on\s+|על\s+)?$/iu.test(
        prefix,
      )
    ) {
      omitted++;
      continue;
    }
    const spans: SourceOccurrence['spans'] = [];
    let startMs = 0,
      endMs = 0;
    for (const [segmentIndex, segment] of transcript.segments.entries()) {
      const points = Array.from(segment.text);
      const base = segmentOffsets[segmentIndex];
      const left = Math.max(from, base),
        right = Math.min(to, base + points.length);
      if (right <= left) continue;
      if (!spans.length) startMs = segment.startMs;
      endMs = segment.endMs;
      spans.push({
        segmentIndex,
        startChar: points.slice(0, left - base).join('').length,
        endChar: points.slice(0, right - base).join('').length,
      });
    }
    if (!spans.length) {
      omitted++;
      continue;
    }
    candidates.push({
      ref,
      category: data.primaryCategory,
      occurrence: { offset: from, startMs, endMs, mention, spans },
    });
  }
  return { candidates, omitted };
}
