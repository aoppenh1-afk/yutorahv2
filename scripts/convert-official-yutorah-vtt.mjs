import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseVtt } from '../lib/webvtt.mjs';
export { parseVtt } from '../lib/webvtt.mjs';

const language = (text) => {
  const hebrew = /[\u0590-\u05ff\ufb1d-\ufb4f]/.test(text);
  const latin = /[a-z]/i.test(text);
  return hebrew === latin ? null : hebrew ? 'he' : 'en';
};

export function stageTranscript(shiurId, transcriptVtt, chaptersVtt = null) {
  if (!/^\d{1,12}$/.test(shiurId)) throw new Error('Invalid shiur ID.');
  const cues = parseVtt(transcriptVtt);
  if (!cues.length)
    throw new Error(
      'No transcript cues. This lecture has no downloadable transcript.',
    );
  if (cues.length > 5_000 || cues.some((c) => c.text.length > 64_000))
    throw new Error('Transcript exceeds the current publication limits.');
  const segments = cues.map((c) => ({
    ...c,
    speaker: null,
    language: language(c.text),
  }));
  return {
    shiurId,
    source: 'official-yutorah',
    sourceUrl: `https://yutorah.org/lectures/new/${shiurId}`,
    transcript: {
      schemaVersion: 1,
      text: segments.map((c) => c.text).join('\n\n'),
      segments,
      durationMs: Math.max(...segments.map((c) => c.endMs)),
    },
    chapters: chaptersVtt === null ? [] : parseVtt(chaptersVtt),
  };
}

async function main(args) {
  const usage =
    'node scripts/convert-official-yutorah-vtt.mjs --shiur-id ID --transcript FILE [--chapters FILE] --output FILE';
  if (args.includes('--help')) {
    console.log(usage);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--shiur-id', '--transcript', '--chapters', '--output'].includes(
        args[i],
      ) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      options[args[i]]
    )
      throw new Error(usage);
    options[args[i]] = args[i + 1];
  }
  if (
    !options['--shiur-id'] ||
    !options['--transcript'] ||
    !options['--output']
  )
    throw new Error(usage);
  const files = {};
  for (const kind of ['transcript', 'chapters']) {
    const file = options[`--${kind}`];
    if (!file) continue;
    if (resolve(file) === resolve(options['--output']))
      throw new Error('Output must differ from input.');
    const info = await stat(file);
    if (info.size > 8 * 1024 * 1024)
      throw new Error('Input file is too large.');
    const bytes = await readFile(file);
    files[kind] = { bytes, retrievedAt: info.mtime.toISOString() };
  }
  const id = options['--shiur-id'];
  const result = stageTranscript(
    id,
    files.transcript.bytes.toString('utf8'),
    files.chapters?.bytes.toString('utf8') ?? null,
  );
  result.retrievedAt = files.transcript.retrievedAt;
  result.files = Object.fromEntries(
    Object.entries(files).map(([kind, file]) => [
      kind,
      {
        url: `https://yutorah.org/lectures/${kind}/vtt/${id}`,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        bytes: file.bytes.length,
      },
    ]),
  );
  const json = JSON.stringify(result, null, 2) + '\n';
  if (Buffer.byteLength(json) > 8 * 1024 * 1024)
    throw new Error('Output is too large.');
  await writeFile(options['--output'], json, { flag: 'wx' });
  console.log(
    `${id}: ${result.transcript.segments.length} segments, ${result.chapters.length} chapters staged.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
