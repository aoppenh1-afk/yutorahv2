import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Pool } from 'pg';
import {
  generateNotes,
  notesProfile,
  notesViolations,
} from '../packages/transcription/src/notes.js';
import {
  withOpenCode,
  FREE_NOTES_MODEL,
  openCodeIdentity,
} from '../packages/opencode-acp/src/runtime.js';
import {
  withRuntime,
  release,
} from '../packages/antigravity-acp/src/runtime.js';
import { runtimeIdentity } from '../apps/worker/src/worker.js';
import { digest } from '../packages/transcription/src/fingerprint.js';
import { Failure, failure } from '../packages/antigravity-acp/src/errors.js';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) =>
  args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback;
const providers = option('--provider', 'both').split(',');
if (providers.includes('both'))
  providers.splice(0, providers.length, 'gemini', 'opencode');
if (providers.some((p) => !['gemini', 'opencode', 'prepare'].includes(p)))
  throw new Failure('configuration');
const output = resolve(
  option('--output', 'benchmarks/opencode-notes-20261008'),
);
const ids = option(
  '--ids',
  '1117682,1151241,1056185,1122687,1183432,1180975,1181377,1181042',
).split(',');
if (ids.length < 5 || ids.length > 10 || ids.some((id) => !/^\d+$/.test(id)))
  throw new Failure('configuration');
const repeats = Number(option('--repeats', '1'));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3)
  throw new Failure('configuration');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Failure('cancelled')));
process.once('SIGTERM', () => controller.abort(new Failure('cancelled')));
const envFile = option('--worker-env', '/etc/yutorah-operator.env');
const env: Record<string, string> = {};
for (const line of (await readFile(envFile, 'utf8').catch(() => '')).split(
  '\n',
)) {
  const match = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
  if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}
const openCode = {
  executable: process.env.OPENCODE_EXECUTABLE ?? 'opencode-notes',
  scratch: join(output, 'scratch', 'opencode'),
};
const gemini = {
  directory: env.ACP_RUNTIME_DIR ?? `/opt/antigravity-acp/${release.version}`,
  profile: join(env.WORKER_STATE_DIR ?? '/var/lib/yutorah-worker', 'profile'),
  scratch: join(output, 'scratch', 'gemini'),
};
const transcriptionSkill = await readFile(
  'packages/transcription/skills/lectern-transcription/SKILL.md',
  'utf8',
);
const notesSkill = await readFile(
  'packages/transcription/skills/lectern-notes/SKILL.md',
  'utf8',
);
await mkdir(output, { recursive: true });
type Source = {
  id: string;
  title: string;
  teacher: string;
  duration_ms: string;
  transcript_id: string;
  text: string;
  existing_notes: string | null;
  existing_notes_model: string | null;
};
let sources: Source[];
if (args.includes('--reuse-corpus')) {
  const saved = JSON.parse(
    await readFile(join(output, 'manifest.json'), 'utf8'),
  );
  if (
    saved.skillHash !== digest(notesSkill) ||
    saved.transcriptionSkillHash !== digest(transcriptionSkill)
  )
    throw new Failure('checkpoint');
  sources = await Promise.all(
    saved.sources.map(
      async (
        source: Source & {
          sourceFile: string;
          existingNotesFile: string | null;
          sourceHash: string;
        },
      ) => {
        const text = await readFile(join(output, source.sourceFile), 'utf8');
        if (digest(text) !== source.sourceHash) throw new Failure('checkpoint');
        return {
          ...source,
          text,
          existing_notes: source.existingNotesFile
            ? await readFile(join(output, source.existingNotesFile), 'utf8')
            : null,
        };
      },
    ),
  );
} else {
  const pool = new Pool({
    connectionString:
      process.env.BENCHMARK_DATABASE_URL ??
      'postgresql:///yutorah_transcription?host=/var/run/postgresql',
    connectionTimeoutMillis: 10_000,
  });
  try {
    sources = (
      await pool.query<Source>(
        `SELECT h.id,h.title,h.teacher,t.duration_ms,t.id AS transcript_id,t.text,n.markdown AS existing_notes,v.model AS existing_notes_model
     FROM transcription_shiurim h JOIN transcripts t ON h.active_transcript_id=t.id
     LEFT JOIN LATERAL (SELECT * FROM transcript_notes WHERE transcript_id=t.id ORDER BY created_at DESC LIMIT 1) n ON true
     LEFT JOIN notes_jobs j ON j.id=n.id LEFT JOIN notes_versions v ON v.id=j.version_id
     WHERE h.id=ANY($1::text[]) ORDER BY t.duration_ms`,
        [ids],
      )
    ).rows;
  } finally {
    await pool.end();
  }
}
if (
  sources.length !== ids.length ||
  sources.some((source) => !ids.includes(source.id))
)
  throw new Failure('configuration');
const manifest = sources.map(({ text, existing_notes, ...source }) => ({
  ...source,
  url: `https://www.yutorah.org/lectures/lecture.cfm/${source.id}`,
  sourceHash: digest(text),
  sourceBytes: Buffer.byteLength(text),
  sourceWords: text.split(/\s+/).length,
  sourceFile: `${source.id}-transcript.md`,
  existingNotesFile: existing_notes
    ? `${source.id}-existing-gemini-notes.md`
    : null,
}));
if (!args.includes('--reuse-corpus')) {
  for (const source of sources) {
    await writeFile(join(output, `${source.id}-transcript.md`), source.text);
    if (source.existing_notes)
      await writeFile(
        join(output, `${source.id}-existing-gemini-notes.md`),
        source.existing_notes,
      );
  }
  await writeFile(
    join(output, 'manifest.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        skillHash: digest(notesSkill),
        transcriptionSkillHash: digest(transcriptionSkill),
        sources: manifest,
        method:
          'Identical saved transcript and full notes skill for both providers; notes-2; no audio or cleanup call. One structural repair allowed. Existing notes are historical references, not paired timing baselines.',
      },
      null,
      2,
    ) + '\n',
  );
}
if (!providers.includes('prepare')) {
  for (const provider of providers) {
    const model =
      provider === 'opencode' ? FREE_NOTES_MODEL : 'gemini-3.8-flash-medium';
    const profile = notesProfile({
      model,
      language: 'hebrewEnglish',
      runtime:
        provider === 'opencode'
          ? openCodeIdentity(openCode)
          : runtimeIdentity(),
      transcriptionSkill,
      notesSkill,
    });
    const results: Record<string, unknown>[] = [];
    let blocked: string | undefined;
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const source of sources) {
        const key = `${source.id}-${provider}-${repeat}`;
        const filename = join(output, `${key}-result.json`);
        const previous = await readFile(filename, 'utf8')
          .then((text) => JSON.parse(text))
          .catch(() => null);
        if (
          previous?.status === 'completed' &&
          previous.sourceHash === digest(source.text) &&
          previous.profileId === profile.id
        ) {
          results.push(previous);
          continue;
        }
        const requests: Record<string, unknown>[] = [];
        const started = performance.now();
        let status = 'completed';
        let error: string | undefined;
        let markdown = '';
        try {
          const result = await generateNotes({
            profile,
            source: source.text,
            signal: controller.signal,
            saveCleaned: async (text) => {
              if (text !== source.text.trim()) throw new Failure('checkpoint');
            },
            request: async (prompt) => {
              const requestStarted = performance.now();
              const kind = prompt.includes('<draft-notes>')
                ? 'notes_repair'
                : 'notes';
              let response = '';
              let code: string | undefined;
              let diagnostics: unknown;
              const operation = async (
                client: Parameters<Parameters<typeof withRuntime>[2]>[0],
                workspace: string,
              ) => {
                await client.authenticate();
                await client.session(workspace, model);
                const promptStarted = performance.now();
                try {
                  response = await client.textPrompt(prompt);
                  return response;
                } finally {
                  diagnostics = {
                    ...client.diagnostics,
                    promptMs: performance.now() - promptStarted,
                  };
                }
              };
              try {
                return provider === 'opencode'
                  ? await withOpenCode(openCode, controller.signal, operation)
                  : await withRuntime(gemini, controller.signal, operation);
              } catch (e) {
                code = failure(e).code;
                throw e;
              } finally {
                if (response)
                  await writeFile(
                    join(output, `${key}-${kind}-raw.md`),
                    response,
                  );
                requests.push({
                  kind,
                  elapsedMs: performance.now() - requestStarted,
                  inputBytes: Buffer.byteLength(prompt),
                  outputBytes: Buffer.byteLength(response),
                  diagnostics,
                  error: code,
                });
              }
            },
          });
          markdown = result.markdown;
          await writeFile(join(output, `${key}-notes.md`), markdown);
        } catch (e) {
          status = 'failed';
          error = failure(e).code;
          if (
            ['auth_required', 'configuration', 'quota_exhausted'].includes(
              error,
            )
          )
            blocked = error;
        }
        const result = {
          id: source.id,
          provider,
          model,
          repeat,
          profileId: profile.id,
          sourceHash: digest(source.text),
          status,
          error,
          elapsedMs: performance.now() - started,
          requests,
          repairCalls: requests.filter((r) => r.kind === 'notes_repair').length,
          words: markdown ? markdown.split(/\s+/).length : 0,
          hebrewWords: markdown.match(/[\u0590-\u05ff]+/g)?.length ?? 0,
          violations: markdown
            ? notesViolations(markdown, source.text)
            : null,
          notesFile: markdown ? `${key}-notes.md` : null,
        };
        results.push(result);
        await writeFile(filename, JSON.stringify(result, null, 2) + '\n');
        console.log(
          JSON.stringify({
            id: source.id,
            provider,
            repeat,
            status,
            error,
            elapsedMs: Math.round(result.elapsedMs),
            repairs: result.repairCalls,
          }),
        );
        if (blocked || controller.signal.aborted) break;
      }
      if (blocked || controller.signal.aborted) break;
    }
    await writeFile(
      join(output, `${provider}-results.json`),
      JSON.stringify(
        {
          model,
          results,
          blocked,
          completed: results.filter((r) => r.status === 'completed').length,
          planned: sources.length * repeats,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
