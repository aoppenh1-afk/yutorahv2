import { Failure } from '../../antigravity-acp/src/errors.js';
import type { Range, Segment, Settings, Transcript } from './types.js';

export function parseTranscript(
  output: string,
  durationMs: number,
  settings: Settings,
): Segment[] {
  const text = output
    .trim()
    .replace(/^```[^\n]*\n/, '')
    .replace(/\n```$/, '')
    .trim();
  const matches = [
    ...text.matchAll(
      /^[ \t]*\[(\d{1,3}(?::\d{1,2}){1,2})(?:[.,](\d{1,3}))?\][ \t]*/gm,
    ),
  ];
  if (!matches.length || text.slice(0, matches[0].index).trim())
    throw new Failure('invalid_transcript');
  let previous = 0;
  const segments: Segment[] = matches.map((m, i) => {
    const parts = m[1].split(':').map(Number);
    if (parts.slice(1).some((n) => n >= 60))
      throw new Failure('invalid_transcript');
    const raw =
      parts.reduce((s, n) => s * 60 + n, 0) * 1000 +
      Number((m[2] ?? '').padEnd(3, '0'));
    if (raw + 2000 < previous || raw > durationMs + 2000)
      throw new Failure('invalid_transcript');
    const startMs = Math.min(durationMs, Math.max(previous, raw));
    previous = startMs;
    let body = text
      .slice(m.index! + m[0].length, matches[i + 1]?.index ?? text.length)
      .trim();
    if (!body || (/^\s*[[{]/.test(body) && /"segments"\s*:/.test(body)))
      throw new Failure('invalid_transcript');
    let speaker: string | null = null;
    const role = body.match(
      /^(?:\*\*)?([^:\n]{1,40}):(?:\*\*)?[ \t]+([\s\S]+)$/,
    );
    if (
      settings.speakers &&
      role &&
      /speaker|professor|teacher|student|rabbi|rav|rebbe|audience|questioner/i.test(
        role[1],
      )
    ) {
      speaker = role[1].trim();
      body = role[2].trim();
    }
    const hebrew = /[\u0590-\u05ff\ufb1d-\ufb4f]/.test(body);
    const latin = /[a-z]/i.test(body);
    const language =
      settings.language === 'english'
        ? 'en'
        : hebrew === latin
          ? null
          : hebrew
            ? 'he'
            : 'en';
    return { startMs, endMs: durationMs, text: body, speaker, language };
  });
  segments.forEach((s, i) => {
    s.endMs = segments[i + 1]?.startMs ?? durationMs;
  });
  if (!validSegments(segments, durationMs))
    throw new Failure('invalid_transcript');
  return segments;
}

export function validSegments(
  value: unknown,
  durationMs: number,
): value is Segment[] {
  if (!Array.isArray(value) || !value.length || value.length > 100_000)
    return false;
  let previous = 0;
  return value.every((s) => {
    if (
      !s ||
      !Number.isSafeInteger(s.startMs) ||
      !Number.isSafeInteger(s.endMs) ||
      s.startMs < previous ||
      s.endMs < s.startMs ||
      s.endMs > durationMs ||
      typeof s.text !== 'string' ||
      !s.text.trim() ||
      s.text.length > 4 * 1024 * 1024 ||
      !(
        s.speaker === null ||
        (typeof s.speaker === 'string' && s.speaker.length <= 40)
      ) ||
      !(
        s.language === null ||
        (typeof s.language === 'string' &&
          /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(s.language))
      )
    )
      return false;
    previous = s.startMs;
    return true;
  });
}
const token = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** Lectern's boundary-only exact token overlap; never globally deduplicate speech. */
export function mergeBoundary(
  existing: Segment[],
  incoming: Segment[],
  boundary: number,
  overlap: number,
): Segment[] {
  if (!existing.length) return incoming;
  const left = existing.filter((s) => s.endMs >= boundary - overlap);
  const right = incoming.filter((s) => s.startMs <= boundary + overlap);
  const a = (left.length ? left : existing.slice(-1))
    .flatMap((s) => words(s.text).map(token).filter(Boolean))
    .slice(-80);
  const b = (right.length ? right : incoming.slice(0, 1))
    .flatMap((s) => words(s.text).map(token).filter(Boolean))
    .slice(0, 80);
  let count = 0;
  for (let n = Math.min(a.length, b.length); n > 0; n--) {
    if (
      (n >= 3 || b.slice(0, n).join('').length >= 12) &&
      a.slice(-n).every((t, i) => t === b[i])
    ) {
      count = n;
      break;
    }
  }
  const trimmed: Segment[] = [];
  for (const s of incoming) {
    if (!count) {
      trimmed.push({ ...s });
      continue;
    }
    const list = words(s.text);
    let removed = 0;
    while (removed < list.length && count > 0) {
      if (token(list[removed])) count--;
      removed++;
    }
    if (removed < list.length)
      trimmed.push({
        ...s,
        text: list.slice(removed).join(' '),
        startMs: Math.max(s.startMs, boundary),
      });
  }
  let previous = 0;
  return [...existing, ...trimmed].map((s) => {
    const startMs = Math.max(s.startMs, previous);
    previous = startMs;
    return { ...s, startMs, endMs: Math.max(startMs, s.endMs) };
  });
}
export function mergeChunks(
  ranges: Range[],
  parts: Segment[][],
  durationMs: number,
): Transcript {
  if (ranges.length !== parts.length || parts.some((p) => !p?.length))
    throw new Failure('checkpoint');
  let segments: Segment[] = [];
  for (const [i, range] of ranges.entries()) {
    const offset = Math.round(range.start * 1000);
    const shifted = parts[i].map((s) => ({
      ...s,
      startMs: Math.min(durationMs, s.startMs + offset),
      endMs: Math.min(durationMs, s.endMs + offset),
    }));
    segments = mergeBoundary(
      segments,
      shifted,
      Math.round(range.coreStart * 1000),
      Math.round((range.coreStart - range.start) * 1000),
    );
  }
  if (!validSegments(segments, durationMs))
    throw new Failure('invalid_transcript');
  return {
    schemaVersion: 1,
    durationMs,
    segments,
    text: segments.map((s) => s.text).join('\n\n'),
  };
}
