function timestamp(value) {
  const match = value.match(/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/);
  if (!match) throw new Error(`Invalid WebVTT timestamp: ${value}`);
  const [, hours = '0', minutes, seconds, milliseconds] = match;
  const result =
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1_000 +
    Number(milliseconds);
  if (!Number.isSafeInteger(result)) throw new Error('Timestamp is too large.');
  return result;
}

/** Preserve source text and overlapping cues; do not derive ends from starts. */
/** @param {string} input */
export function parseVtt(input) {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/^WEBVTT(?:[ \t][^\n]*)?\n/.test(text))
    throw new Error('Expected WebVTT, not an HTML page or challenge response.');
  const blocks = text.split(/\n[ \t]*\n/);
  const cues = [];
  for (const block of blocks.slice(1)) {
    const lines = block.trim().split('\n');
    if (!block.trim() || /^(?:NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0]))
      continue;
    const index = lines[0].includes('-->') ? 0 : 1;
    const timing = lines[index]?.match(
      /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+.*)?$/,
    );
    if (!timing) throw new Error('Malformed WebVTT cue.');
    const startMs = timestamp(timing[1]);
    const endMs = timestamp(timing[2]);
    const body = lines.slice(index + 1).join('\n');
    if (
      !body ||
      endMs < startMs ||
      (cues.length && startMs < cues.at(-1).startMs)
    )
      throw new Error('Empty or invalid WebVTT cue.');
    cues.push({ startMs, endMs, text: body });
  }
  return cues;
}
