import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runProcess } from '../../antigravity-acp/src/process.js';
import { Failure } from '../../antigravity-acp/src/errors.js';
import {
  MAX_AUDIO_BYTES,
  TARGET_BYTES,
  planRanges,
  quietestBoundary,
  type Energy,
} from './planning.js';
import type { Range } from './types.js';

export type AudioInfo = {
  bytes: number;
  durationMs: number;
  passthrough: boolean;
  mimeType: string;
};
export async function inspectAudio(
  path: string,
  signal: AbortSignal,
): Promise<AudioInfo> {
  const data = await runProcess(
    '/usr/bin/ffprobe',
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_entries',
      'format=duration,format_name:stream=codec_name,codec_type',
      '-of',
      'json',
      path,
    ],
    { cwd: dirname(path), signal, timeoutMs: 60_000 },
  );
  let probe: {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string }>;
  };
  try {
    probe = JSON.parse(data.toString());
  } catch {
    throw new Failure('invalid_audio');
  }
  const durationMs = Math.round(Number(probe.format?.duration) * 1000);
  const tracks = probe.streams?.filter((t) => t.codec_type === 'audio') ?? [];
  if (
    !tracks.length ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > 12 * 3600_000
  )
    throw new Failure('invalid_audio');
  const format = probe.format?.format_name ?? '';
  const mimeType = format.includes('mp3')
    ? 'audio/mp3'
    : format.includes('wav')
      ? 'audio/wav'
      : format.includes('flac')
        ? 'audio/flac'
        : format.includes('ogg')
          ? 'audio/ogg'
          : format.includes('aac')
            ? 'audio/aac'
            : format.includes('mov')
              ? 'audio/m4a'
              : format.includes('webm')
                ? 'audio/webm'
                : '';
  if (!mimeType) throw new Failure('invalid_audio');
  return {
    bytes: (await stat(path)).size,
    durationMs,
    mimeType,
    passthrough: tracks.every((t) =>
      ['aac', 'alac'].includes(t.codec_name ?? ''),
    ),
  };
}
export async function audioPreparationIdentity(
  signal: AbortSignal,
  cwd: string,
): Promise<string> {
  const data = await runProcess('/usr/bin/ffmpeg', ['-version'], {
    cwd,
    signal,
  });
  return data.toString().split('\n')[0];
}
async function energyNear(
  path: string,
  target: number,
  signal: AbortSignal,
): Promise<Energy[]> {
  const start = Math.max(0, target - 15);
  const data = await runProcess(
    '/usr/bin/ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-ss',
      String(start),
      '-i',
      path,
      '-t',
      '30',
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      'pipe:1',
    ],
    { cwd: dirname(path), signal, maxBytes: 2 * 1024 * 1024 },
  );
  const points: Energy[] = [];
  // 20ms RMS windows, smoothed by the portable Lectern boundary selection.
  for (let offset = 0; offset + 640 <= data.length; offset += 640) {
    let sum = 0;
    for (let i = offset; i < offset + 640; i += 2)
      sum += (data.readInt16LE(i) / 32767) ** 2;
    points.push({
      time: start + offset / 32000 + 0.01,
      rms: Math.sqrt(sum / 320),
    });
  }
  return points;
}
export async function prepareRanges(
  path: string,
  info: AudioInfo,
  signal: AbortSignal,
): Promise<Range[]> {
  const duration = info.durationMs / 1000;
  if (info.bytes <= TARGET_BYTES)
    return [{ start: 0, end: duration, coreStart: 0, coreEnd: duration }];
  const bytes = info.passthrough
    ? info.bytes
    : Math.max(info.bytes, Math.ceil(duration * 48_000));
  const nominal = planRanges(bytes, duration);
  const boundaries: number[] = [];
  for (const range of nominal.slice(0, -1)) {
    // A decoding failure must not mask cancellation; preparation errors are explicit.
    boundaries.push(
      quietestBoundary(
        range.coreEnd,
        await energyNear(path, range.coreEnd, signal),
      ),
    );
  }
  return planRanges(bytes, duration, boundaries);
}
export async function exportChunk(
  source: string,
  info: AudioInfo,
  range: Range,
  index: number,
  total: number,
  directory: string,
  signal: AbortSignal,
): Promise<{ path: string; mimeType: string }> {
  if (total === 1 && info.bytes <= MAX_AUDIO_BYTES)
    return { path: source, mimeType: info.mimeType };
  const path = join(directory, `part-${index}.m4a`);
  await runProcess(
    '/usr/bin/ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-ss',
      String(range.start),
      '-i',
      source,
      '-t',
      String(range.end - range.start),
      '-map',
      '0:a:0',
      '-vn',
      '-map_metadata',
      '-1',
      ...(info.passthrough
        ? ['-c:a', 'copy']
        : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
      '-y',
      path,
    ],
    { cwd: directory, signal },
  );
  const size = (await stat(path)).size;
  if (!size || size > MAX_AUDIO_BYTES) throw new Failure('invalid_audio');
  return { path, mimeType: 'audio/m4a' };
}
