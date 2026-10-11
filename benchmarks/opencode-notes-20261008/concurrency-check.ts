import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateNotes,
  notesProfile,
  notesViolations,
} from '../../packages/transcription/src/notes.js';
import {
  FREE_NOTES_MODEL,
  openCodeIdentity,
  withOpenCode,
} from '../../packages/opencode-acp/src/runtime.js';
import { digest } from '../../packages/transcription/src/fingerprint.js';
import { failure } from '../../packages/antigravity-acp/src/errors.js';

const output = dirname(fileURLToPath(import.meta.url));
const config = {
  executable: process.env.OPENCODE_EXECUTABLE ?? 'opencode-notes',
  scratch: join(output, 'scratch', 'concurrency'),
};
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const manifest = JSON.parse(
  await readFile(join(output, 'manifest.json'), 'utf8'),
);
const transcriptionSkill = await readFile(
  'packages/transcription/skills/lectern-transcription/SKILL.md',
  'utf8',
);
const notesSkill = await readFile(
  'packages/transcription/skills/lectern-notes/SKILL.md',
  'utf8',
);
if (
  digest(notesSkill) !== manifest.skillHash ||
  digest(transcriptionSkill) !== manifest.transcriptionSkillHash
)
  throw new Error('Benchmark contract changed');
const profile = notesProfile({
  model: FREE_NOTES_MODEL,
  language: 'hebrewEnglish',
  runtime: openCodeIdentity(config),
  transcriptionSkill,
  notesSkill,
});
const started = performance.now();
const results = await Promise.all(
  ['1117682', '1183432'].map(async (id) => {
    const sourceInfo = manifest.sources.find(
      (source: { id: string }) => source.id === id,
    );
    const source = await readFile(join(output, sourceInfo.sourceFile), 'utf8');
    if (digest(source) !== sourceInfo.sourceHash)
      throw new Error('Source changed');
    const jobStarted = performance.now();
    let calls = 0;
    const requests: Record<string, unknown>[] = [];
    try {
      const result = await generateNotes({
        profile,
        source,
        signal: controller.signal,
        saveCleaned: async (text) => {
          if (text !== source.trim()) throw new Error('Source changed');
        },
        request: async (prompt) => {
          calls++;
          const requestStarted = performance.now();
          return withOpenCode(
            config,
            controller.signal,
            async (client, workspace) => {
              await client.authenticate();
              await client.session(workspace, FREE_NOTES_MODEL);
              const promptStarted = performance.now();
              const text = await client.textPrompt(prompt);
              requests.push({
                elapsedMs: performance.now() - requestStarted,
                promptMs: performance.now() - promptStarted,
                ...client.diagnostics,
              });
              return text;
            },
          );
        },
      });
      await writeFile(
        join(output, `concurrent-${id}-notes.md`),
        result.markdown,
      );
      return {
        id,
        status: 'completed',
        elapsedMs: performance.now() - jobStarted,
        calls,
        repairCalls: Math.max(0, calls - 1),
        violations: notesViolations(result.markdown, source),
        sourceHash: digest(source),
        requests,
      };
    } catch (error) {
      return {
        id,
        status: 'failed',
        elapsedMs: performance.now() - jobStarted,
        calls,
        error: failure(error).code,
        sourceHash: digest(source),
        requests,
      };
    }
  }),
);
const result = {
  model: FREE_NOTES_MODEL,
  runtime: profile.runtime,
  profileId: profile.id,
  concurrency: 2,
  elapsedMs: performance.now() - started,
  results,
  method:
    'Two full notes jobs launched together using the same pinned source and skill as the paired benchmark. A single short check, not a sustained free-quota measurement.',
};
await writeFile(
  join(output, 'concurrency-check.json'),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(JSON.stringify(result));
if (results.some((r) => r.status !== 'completed')) process.exitCode = 1;
