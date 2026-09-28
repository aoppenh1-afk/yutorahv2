import { Failure } from '../../antigravity-acp/src/errors.js';
import type { Range } from './types.js';
export const TARGET_BYTES = 16 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export type Energy = { time: number; rms: number };

export function quietestBoundary(target: number, energy: Energy[]): number {
  const candidates = energy.filter((e) => Math.abs(e.time - target) <= 15);
  if (!candidates.length) return target;
  const smoothed = candidates.map((e) => {
    const neighbors = candidates.filter(
      (n) => Math.abs(n.time - e.time) <= 0.35,
    );
    return {
      time: e.time,
      rms: Math.sqrt(
        neighbors.reduce((s, n) => s + n.rms ** 2, 0) / neighbors.length,
      ),
    };
  });
  const min = Math.min(...smoothed.map((e) => e.rms));
  return smoothed
    .filter((e) => e.rms <= min * 1.25 + 0.00001)
    .sort((a, b) => Math.abs(a.time - target) - Math.abs(b.time - target))[0]
    .time;
}
export function planRanges(
  bytes: number,
  duration: number,
  boundaries?: number[],
  target = TARGET_BYTES,
): Range[] {
  if (!Number.isFinite(duration) || duration <= 0 || bytes <= 0 || target <= 0)
    throw new Failure('invalid_audio');
  const count = Math.ceil(bytes / target);
  if (count > 10_000) throw new Failure('invalid_audio');
  const nominal =
    boundaries ??
    Array.from(
      { length: Math.max(0, count - 1) },
      (_, i) => (duration * (i + 1)) / count,
    );
  const maxDuration = (MAX_AUDIO_BYTES - 64 * 1024) / (bytes / duration);
  const points = [0];
  for (const [i, point] of nominal.entries()) {
    const spacing = duration / ((nominal.length + 1) * 10);
    const remaining = nominal.length - i;
    const lower = Math.max(
      points.at(-1)! + spacing,
      duration - maxDuration * remaining,
    );
    const upper = Math.min(
      points.at(-1)! + maxDuration,
      duration - spacing * remaining,
    );
    points.push(Math.min(upper, Math.max(lower, point)));
  }
  points.push(duration);
  return points.slice(0, -1).map((coreStart, i) => {
    const coreEnd = points[i + 1];
    const before = i === 0 ? 0 : Math.min(5, coreStart);
    const after = i === points.length - 2 ? 0 : Math.min(5, duration - coreEnd);
    const scale =
      before + after
        ? Math.min(
            1,
            Math.max(0, maxDuration - (coreEnd - coreStart)) / (before + after),
          )
        : 0;
    return {
      coreStart,
      coreEnd,
      start: coreStart - before * scale,
      end: coreEnd + after * scale,
    };
  });
}
export function validRanges(
  value: unknown,
  duration: number,
): value is Range[] {
  if (!Array.isArray(value) || !value.length || value.length > 10_000)
    return false;
  let previous = 0;
  for (const r of value) {
    if (
      !r ||
      ![r.start, r.end, r.coreStart, r.coreEnd].every(Number.isFinite) ||
      r.start < 0 ||
      r.start > r.coreStart ||
      r.coreEnd <= r.coreStart ||
      r.end < r.coreEnd ||
      r.end > duration + 0.001 ||
      Math.abs(previous - r.coreStart) > 0.001
    )
      return false;
    previous = r.coreEnd;
  }
  return Math.abs(previous - duration) < 0.001;
}
