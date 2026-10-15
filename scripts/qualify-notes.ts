/** Local-only qualification runner. Holds production's mutation lock; never constructs a TiDB writer. */
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NotesQueue } from '../packages/notes-only/src/queue.js';
import { OpenCodeServer } from '../packages/opencode-acp/src/server.js';
import {
  withOpenCode,
  FREE_NOTES_MODEL,
  openCodeIdentity,
} from '../packages/opencode-acp/src/runtime.js';
import {
  InferenceLimiter,
  PipelineFailure,
} from '../packages/notes-only/src/control.js';
import {
  notesProfile,
  generateNotes,
  notesViolations,
} from '../packages/notes-only/src/notes.js';
import { fetchOfficialVtt } from '../lib/official-transcript.mjs';
import { parseVtt } from '../lib/webvtt.mjs';
import { availableMemoryMiB } from '../packages/notes-only/src/coordinator.js';
import {
  pinSource,
  durableWrite,
  digest,
} from '../packages/notes-only/src/artifacts.js';
const args = process.argv.slice(2),
  option = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
const root = resolve(option('--output', 'outputs/notes-qualification'));
const executable = option('--opencode', '/home/box/.local/bin/opencode-notes');
const route = option('--route', 'server-high');
if (!['server-high', 'acp-high'].includes(route))
  throw new Error('Unsupported route.');
const concurrency = Number(option('--concurrency', '2'));
if (![1, 2, 3, 4, 5, 6].includes(concurrency))
  throw new Error('Invalid concurrency.');
if (concurrency > 4 && !args.includes('--headroom-qualified'))
  throw new Error(
    'First record successful trials at 2 and 4 sessions; higher cohorts require explicit headroom qualification.',
  );
const production = resolve(
  option('--production-state', join(homedir(), '.local/share/yutorah-notes')),
);
if (root === production)
  throw new Error('Qualification output must be separate from production.');
await readFile(join(production, 'paused')).catch(() => {
  throw new Error('Pause production before qualification.');
});
if (process.env.NOTES_QUALIFICATION_LOCK_HELD !== '1') {
  const child = spawn(
    'flock',
    [
      '-n',
      '-E',
      '75',
      join(production, 'process.lock'),
      process.execPath,
      '--import',
      'tsx',
      fileURLToPath(import.meta.url),
      ...args,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, NOTES_QUALIFICATION_LOCK_HELD: '1' },
    },
  );
  for (const name of ['SIGTERM', 'SIGINT'] as const)
    process.once(name, () => {
      child.kill(name);
    });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exit(code);
}
await mkdir(root, { recursive: true, mode: 0o700 });
const queue = new NotesQueue(join(root, 'queue.sqlite'));
const server = new OpenCodeServer(
  {
    executable,
    root: join(root, 'runtime', 'server'),
    deadlineMs: 1200_000,
    catalogTtlMs: 60_000,
  },
  queue,
);
const abort = new AbortController();
for (const name of ['SIGTERM', 'SIGINT'])
  process.once(name, () => abort.abort());
const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3600000)]);
const limiter = new InferenceLimiter(queue, {
  concurrency,
  spacingMs: 2000,
  requestsPerMinute: 30,
  tokensPerMinute: 2000_000,
  outputReservation: 131072,
});
const notesSkill = await readFile(
  'packages/notes-only/skills/written-shiur-notes/SKILL.md',
  'utf8',
);
const profile = notesProfile({
  model: FREE_NOTES_MODEL,
  language: 'hebrewEnglish',
  runtime:
    route === 'acp-high'
      ? openCodeIdentity({ executable, scratch: root })
      : 'opencode:1.18.33:server:plan:high:v1',
  notesSkill,
});
const ids = option('--ids', '1117682,1056185,1122687,1151241').split(',');
if (ids.length < concurrency || ids.some((id) => !/^\d+$/.test(id)))
  throw new Error(
    'Provide at least one complete source per concurrent session.',
  );
const manifest: {
  at: number;
  route: string;
  profile: string;
  concurrency: number;
  sources: unknown[];
  attempts: unknown[];
  serverPeakRssKiB: number;
  elapsedMs?: number;
  acceptedHumanNotes: number;
  published: number;
  minAvailableMemoryMiB: number;
  memoryAdmissionWaitMs: number;
  maxActualSessions: number;
  runtimeMonitor?: unknown;
  requests?: unknown;
} = {
  at: Date.now(),
  route,
  profile: profile.id,
  concurrency,
  sources: [],
  attempts: [],
  serverPeakRssKiB: 0,
  acceptedHumanNotes: 0,
  published: 0,
  minAvailableMemoryMiB: Infinity,
  memoryAdmissionWaitMs: 0,
  maxActualSessions: 0,
};
let sampler: ReturnType<typeof setInterval> | undefined;
try {
  await server.guard();
  const owner = JSON.parse(
    await readFile(join(root, 'runtime/server/owner.json'), 'utf8'),
  );
  const sample = () => {
    const rows = execFileSync('ps', ['-eo', 'pid,ppid,rss'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/).map(Number));
    const owned = new Set<number>([owner.pid]);
    for (let i = 0; i < 10; i++)
      for (const [pid, ppid] of rows) if (owned.has(ppid)) owned.add(pid);
    manifest.serverPeakRssKiB = Math.max(
      manifest.serverPeakRssKiB,
      rows.reduce((sum, [pid, , rss]) => sum + (owned.has(pid) ? rss : 0), 0),
    );
    manifest.maxActualSessions = Math.max(
      manifest.maxActualSessions,
      Number(
        queue.db
          .prepare("SELECT COUNT(*) count FROM sessions WHERE state='active'")
          .get()?.count ?? 0,
      ),
    );
  };
  sample();
  sampler = setInterval(() => {
    sample();
    void availableMemoryMiB()
      .then((memory) => {
        manifest.minAvailableMemoryMiB = Math.min(
          manifest.minAvailableMemoryMiB,
          memory,
        );
      })
      .catch(() => {
        abort.abort();
      });
  }, 500);
  const sources = new Map<string, string>();
  const saved = new NotesQueue(join(production, 'queue.sqlite'), true);
  try {
    for (const id of ids) {
      const cached = saved.db
        .prepare('SELECT source_path,source_hash FROM jobs WHERE id=?')
        .get(id);
      let vtt: string | null;
      if (cached?.source_path) {
        const bytes = await readFile(
          join(production, String(cached.source_path)),
        );
        if (digest(bytes) !== cached.source_hash)
          throw new Error('Frozen source hash changed.');
        vtt = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } else vtt = await fetchOfficialVtt(id, signal);
      if (vtt === null) throw new Error('Qualification source unavailable.');
      const source = await pinSource(root, id, vtt);
      const cues = parseVtt(vtt);
      manifest.sources.push({
        id,
        ...source,
        durationSeconds:
          cues.reduce((end, c) => Math.max(end, c.endMs), 0) / 1000,
      });
      sources.set(
        id,
        parseVtt(vtt)
          .map((c) => c.text.replace(/<[^>]*>/g, ''))
          .join('\n\n'),
      );
    }
  } finally {
    saved.close();
  }
  queue.enqueue(ids.map((id) => ({ id })));
  let index = 0;
  let occupied = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = index++;
        if (i >= ids.length || signal.aborted) return;
        const id = ids[i];
        // Each evaluation job owns a long renewable lease. No TiDB connection is constructed.
        const job = queue.claim('fetching', { leaseMs: 1800_000 })!;
        if (job.id !== id) throw new Error('Evaluation queue order changed.');
        const started = Date.now(),
          folder = join(root, 'attempts', id);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const renewal = setInterval(() => queue.renew(job, 1800_000), 30_000);
        let firstPass: boolean | undefined;
        const repairCodes: string[] = [];
        try {
          const result = await generateNotes({
            profile,
            source: sources.get(id)!,
            signal,
            onValidation: async (validation) => {
              if (validation.kind === 'generation')
                firstPass = validation.codes.length === 0;
              repairCodes.push(...validation.codes);
              await durableWrite(
                join(folder, validation.kind + '.normalized.md'),
                validation.markdown,
              );
              await durableWrite(
                join(folder, validation.kind + '.validation.json'),
                JSON.stringify({
                  normalizer: validation.normalizer,
                  codes: validation.codes,
                }),
              );
            },
            request: (prompt, kind) =>
              limiter.run(
                job,
                route,
                kind,
                prompt,
                signal,
                async (requestID) => {
                  const admissionAt = Date.now();
                  for (;;) {
                    signal.throwIfAborted();
                    const memory = await availableMemoryMiB();
                    manifest.minAvailableMemoryMiB = Math.min(
                      manifest.minAvailableMemoryMiB,
                      memory,
                    );
                    if (memory >= 3072 + occupied * 512) break;
                    await delay(250, undefined, { signal });
                  }
                  occupied++;
                  manifest.memoryAdmissionWaitMs += Date.now() - admissionAt;
                  try {
                    await server.guard();
                    await durableWrite(
                      join(folder, requestID + '.prompt.txt'),
                      prompt,
                    );
                    const response =
                      route === 'server-high'
                        ? await server.request(job, requestID, prompt, signal)
                        : await withOpenCode(
                            {
                              executable,
                              scratch: join(folder, 'acp'),
                              onSession: async (sessionID) => {
                                queue.db
                                  .prepare(
                                    "INSERT INTO sessions VALUES(?,?,?,?,'active',?)",
                                  )
                                  .run(
                                    sessionID,
                                    id,
                                    job.lease_token,
                                    'acp',
                                    Date.now(),
                                  );
                              },
                              onCleanup: async (ids, deleted) => {
                                for (const id of ids)
                                  queue.db
                                    .prepare(
                                      'UPDATE sessions SET state=? WHERE id=?',
                                    )
                                    .run(deleted ? 'deleted' : 'uncertain', id);
                              },
                            },
                            signal,
                            async (client, workspace) => {
                              await client.session(workspace);
                              return client.verifiedPrompt(prompt, 1200_000);
                            },
                          );
                    await durableWrite(
                      join(folder, requestID + '.raw.txt'),
                      response.value,
                    );
                    await durableWrite(
                      join(folder, requestID + '.runtime.json'),
                      JSON.stringify(response),
                    );
                    return response;
                  } finally {
                    occupied--;
                  }
                },
              ),
          });
          await durableWrite(join(folder, 'notes.md'), result.markdown);
          manifest.attempts.push({
            id,
            status: 'structurally_valid',
            ms: Date.now() - started,
            notesHash: digest(result.markdown),
            violations: notesViolations(result.markdown, sources.get(id)!),
            firstPass,
            repairCodes,
          });
          queue.finish(job, { status: 'needs_review', review: 'pending' });
        } catch (error) {
          manifest.attempts.push({
            id,
            status: error instanceof PipelineFailure ? error.code : 'failed',
            ms: Date.now() - started,
            firstPass,
            repairCodes,
          });
          if (queue.owns(job))
            queue.finish(job, {
              status: 'needs_review',
              review: 'pending',
              error: error instanceof PipelineFailure ? error.code : 'failed',
            });
        } finally {
          clearInterval(renewal);
          await durableWrite(
            join(root, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
          );
        }
      }
    }),
  );
} finally {
  if (sampler) clearInterval(sampler);
  await server.close();
  manifest.runtimeMonitor = server.adapter.monitor.status();
  manifest.requests = queue.db
    .prepare(
      'SELECT kind,status,COUNT(*) count,AVG(ended_at-started_at) meanMs FROM requests GROUP BY kind,status',
    )
    .all();
  manifest.elapsedMs = Date.now() - manifest.at;
  await durableWrite(
    join(root, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  queue.close();
  console.log(JSON.stringify({ output: root, ...manifest }));
}
