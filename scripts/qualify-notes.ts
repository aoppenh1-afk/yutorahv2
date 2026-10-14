/** Local-only qualification runner. Invoke under the VM's mutation/provider locks, with production paused. */
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
if (![1, 2, 4, 6, 8, 10].includes(concurrency))
  throw new Error('Invalid concurrency.');
if (concurrency > 4 && !args.includes('--headroom-qualified'))
  throw new Error(
    'First record successful trials at 2 and 4 sessions; higher cohorts require explicit headroom qualification.',
  );
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
const signal = abort.signal;
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
  };
  sample();
  sampler = setInterval(sample, 500);
  const sources = new Map<string, string>();
  for (const id of ids) {
    const vtt = await fetchOfficialVtt(id, signal);
    if (vtt === null) throw new Error('Qualification source unavailable.');
    const source = await pinSource(root, id, vtt);
    manifest.sources.push({ id, ...source });
    sources.set(
      id,
      parseVtt(vtt)
        .map((c) => c.text.replace(/<[^>]*>/g, ''))
        .join('\n\n'),
    );
  }
  queue.enqueue(ids.map((id) => ({ id })));
  let index = 0;
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
        try {
          const result = await generateNotes({
            profile,
            source: sources.get(id)!,
            signal,
            request: (prompt, kind) =>
              limiter.run(
                job,
                route,
                kind,
                prompt,
                signal,
                async (requestID) => {
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
          });
          queue.finish(job, { status: 'needs_review', review: 'pending' });
        } catch (error) {
          manifest.attempts.push({
            id,
            status: error instanceof PipelineFailure ? error.code : 'failed',
            ms: Date.now() - started,
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
  manifest.elapsedMs = Date.now() - manifest.at;
  await durableWrite(
    join(root, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  queue.close();
  console.log(JSON.stringify({ output: root, ...manifest }));
}
