// Two independent high-thinking notes in one owned process, with fresh sessions.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  withOpenCode,
  FREE_NOTES_MODEL,
} from '../../packages/opencode-acp/src/runtime.js';
import {
  generateNotes,
  notesProfile,
} from '../../packages/transcription/src/notes.js';

const output = resolve('benchmarks/notes-speed-20261013');
const profile = notesProfile({
  model: FREE_NOTES_MODEL,
  language: 'hebrewEnglish',
  runtime: 'opencode:1.18.33:warm-high-experiment',
  notesSkill: await readFile(
    'packages/transcription/skills/lectern-notes/SKILL.md',
    'utf8',
  ),
  transcriptionSkill: await readFile(
    'packages/transcription/skills/lectern-transcription/SKILL.md',
    'utf8',
  ),
});
const signal = AbortSignal.timeout(480_000);
const results: Record<string, unknown>[] = [];
const start = performance.now();
let initializedMs: number | undefined;
let beforeCloseMs: number | undefined;
let failureCode: string | undefined;
try {
  await withOpenCode(
    {
      executable: resolve('work/notes-speed-research/runtime/opencode'),
      scratch: resolve('work/notes-speed-research/warm-scratch'),
    },
    signal,
    async (client, workspace) => {
      initializedMs = performance.now() - start;
      for (const id of ['1117682', '1181042']) {
        const source = await readFile(
          `benchmarks/opencode-notes-20261008/${id}-transcript.md`,
          'utf8',
        );
        const requests: unknown[] = [];
        const began = performance.now();
        console.log(
          JSON.stringify({
            status: 'started',
            id,
            route: 'warm-runtime-fresh-session',
            at: new Date().toISOString(),
          }),
        );
        const result = await generateNotes({
          profile,
          source,
          signal,
          saveCleaned: async () => {},
          request: async (prompt) => {
            const sessionStart = performance.now();
            await client.session(workspace, FREE_NOTES_MODEL);
            const sessionMs = performance.now() - sessionStart;
            const promptStart = performance.now();
            const response = await client.textPrompt(prompt, 240_000);
            requests.push({
              repair: prompt.includes('<draft-notes>'),
              sessionMs,
              promptMs: performance.now() - promptStart,
              inputBytes: Buffer.byteLength(prompt),
              outputBytes: Buffer.byteLength(response),
            });
            return response;
          },
        });
        const filename = `${id}-warm-high-notes.md`;
        await writeFile(join(output, filename), result.markdown + '\n');
        const record = {
          id,
          status: 'completed',
          effort: 'high',
          elapsedBeforeSharedCleanupMs: performance.now() - began,
          words: result.markdown.split(/\s+/u).length,
          sourceHash: createHash('sha256').update(source).digest('hex'),
          notesFile: filename,
          requests,
        };
        results.push(record);
        console.log(JSON.stringify(record));
      }
      beforeCloseMs = performance.now() - start;
    },
  );
} catch (error) {
  failureCode = (error as { code?: string }).code ?? (error as Error).name;
}
const totalMs = performance.now() - start;
const artifact = {
  model: FREE_NOTES_MODEL,
  effort: 'high',
  opencodeVersion: '1.18.33',
  profileId: profile.id,
  method:
    'One process and stable owned workspace; two different complete transcripts each receive a fresh session. Model, plan mode, and high confirmed before every request. Full contract and validation, no published notes. One short sequential pilot, different time from cold baseline, not a sustained-throughput or caching measurement.',
  initializedMs,
  sharedCleanupMs: beforeCloseMs === undefined ? null : totalMs - beforeCloseMs,
  totalMs,
  failureCode: failureCode ?? null,
  results,
};
await writeFile(
  join(output, 'warm-runtime-check.json'),
  JSON.stringify(artifact, null, 2) + '\n',
);
console.log(JSON.stringify(artifact));
