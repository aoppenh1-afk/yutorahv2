// Isolated free-only experiment. Does not publish notes or change production settings.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
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
const executable = resolve('work/notes-speed-research/runtime/opencode');
const notesSkill = await readFile(
  'packages/transcription/skills/lectern-notes/SKILL.md',
  'utf8',
);
const transcriptionSkill = await readFile(
  'packages/transcription/skills/lectern-transcription/SKILL.md',
  'utf8',
);
const profile = notesProfile({
  model: FREE_NOTES_MODEL,
  language: 'hebrewEnglish',
  runtime: 'opencode:1.18.33:effort-experiment',
  notesSkill,
  transcriptionSkill,
});
const results: unknown[] = [];
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 600_000);
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
const configs = [
  { id: '1117682', effort: 'medium' },
  { id: '1117682', effort: 'high' },
  { id: '1181042', effort: 'high' },
  { id: '1181042', effort: 'medium' },
];
try {
  for (const config of configs) {
    const source = await readFile(
      `benchmarks/opencode-notes-20261008/${config.id}-transcript.md`,
      'utf8',
    );
    const requests: unknown[] = [];
    const started = performance.now();
    let artifact: Record<string, unknown>;
    console.log(
      JSON.stringify({
        status: 'started',
        ...config,
        at: new Date().toISOString(),
      }),
    );
    try {
      const result = await generateNotes({
        profile,
        source,
        signal: controller.signal,
        saveCleaned: async () => {},
        request: async (prompt) => {
          const start = performance.now();
          let promptMs: number | undefined;
          const response = await withOpenCode(
            {
              executable,
              scratch: resolve('work/notes-speed-research/effort-scratch'),
            },
            controller.signal,
            async (client, workspace) => {
              await client.session(workspace, FREE_NOTES_MODEL);
              // The production client confirms high first. Only this experiment then
              // selects medium and re-confirms the complete free-only selection.
              const sessionId = (client as unknown as { sessionId: string })
                .sessionId;
              const selection = await client.request(
                'session/set_config_option',
                { sessionId, configId: 'effort', value: config.effort },
              );
              const options = selection.configOptions as Array<{
                id: string;
                currentValue: string;
              }>;
              for (const [id, value] of [
                ['model', FREE_NOTES_MODEL],
                ['mode', 'plan'],
                ['effort', config.effort],
              ]) {
                if (
                  !options?.some(
                    (option) =>
                      option.id === id && option.currentValue === value,
                  )
                )
                  throw new Error(
                    'Unconfirmed free-only experiment configuration',
                  );
              }
              const promptStart = performance.now();
              try {
                return await client.textPrompt(prompt, 240_000);
              } finally {
                promptMs = performance.now() - promptStart;
              }
            },
          );
          requests.push({
            repair: prompt.includes('<draft-notes>'),
            elapsedMs: performance.now() - start,
            promptMs,
            inputBytes: Buffer.byteLength(prompt),
            outputBytes: Buffer.byteLength(response),
          });
          return response;
        },
      });
      const filename = `${config.id}-${config.effort}-notes.md`;
      await writeFile(join(output, filename), result.markdown + '\n');
      artifact = {
        ...config,
        status: 'completed',
        elapsedMs: performance.now() - started,
        words: result.markdown.split(/\s+/u).length,
        sourceHash: createHash('sha256').update(source).digest('hex'),
        notesFile: filename,
        requests,
      };
    } catch (error) {
      // Failure codes only. Never emit native provider stderr or authentication data.
      artifact = {
        ...config,
        status: 'failed',
        elapsedMs: performance.now() - started,
        code:
          (error as { code?: string; name?: string }).code ??
          (error as Error).name,
        requests,
      };
    }
    results.push(artifact);
    await writeFile(
      join(output, 'effort-check.json'),
      JSON.stringify(
        {
          model: FREE_NOTES_MODEL,
          opencodeVersion: '1.18.33',
          profileId: profile.id,
          skillHash: createHash('sha256').update(notesSkill).digest('hex'),
          method:
            'One measured run per effort per source, sequential; short source medium/high then longer source high/medium. Full current contract, exact saved sources, one structural repair permitted, denied tools, isolated owned sessions. No sustained-throughput or quality claim.',
          results,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(JSON.stringify(artifact));
    if (artifact.status === 'failed') break;
  }
} finally {
  clearTimeout(deadline);
}
