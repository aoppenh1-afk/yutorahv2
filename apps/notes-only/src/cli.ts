import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { NotesQueue } from '../../../packages/notes-only/src/queue.js';
import {
  NotesPipeline,
  durableWrite,
} from '../../../packages/notes-only/src/pipeline.js';
import {
  TiDBNotesStore,
  type NotesCredential,
} from '../../../lib/tidb-notes-store.js';
import {
  generateNotes,
  notesProfile,
} from '../../../packages/transcription/src/notes.js';
import {
  withOpenCode,
  recoverOpenCode,
  FREE_NOTES_MODEL,
  openCodeIdentity,
} from '../../../packages/opencode-acp/src/runtime.js';
import { catalogPage } from '../../../packages/yutorah-core/src/media.js';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};
const integer = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`Invalid ${name}.`);
  return n;
};
const root = resolve(
  option('--state', join(homedir(), '.local/share/yutorah-notes')),
);
const command = args[0] ?? 'help';
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const controller = abort.signal;
async function main() {
  if (command === 'help') {
    console.log(`Notes-only pipeline. All state belongs under persistent home. No listening ports.
  enqueue --ids 1190357,1190833   Add shiur IDs without transcripts
  enqueue --file ids.txt         One numeric ID per line
  catalog --pages 20            Resume catalog discovery, 30 IDs/page
  run --limit 3                 Process a bounded pilot
  run --all --follow            Continue the queue, wait for quota resets
  status                        Show durable progress
  restore --limit 20            Republish verified local compressed-note backups
Common: --state DIR --credential FILE --opencode EXECUTABLE
Model is pinned to ${FREE_NOTES_MODEL}; paid fallback is forbidden.`);
    return;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (command === 'status') {
    const statusQueue = new NotesQueue(join(root, 'queue.sqlite'));
    try {
      console.log(
        JSON.stringify({
          state: root,
          jobs: statusQueue.status(),
          nextCatalogPage: statusQueue.cursor('catalog'),
        }),
      );
    } finally {
      statusQueue.close();
    }
    return;
  }
  const lock = join(root, 'runner.lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const owner = JSON.parse(
      await readFile(join(lock, 'owner.json'), 'utf8'),
    ) as { pid: number; hostname: string };
    if (owner.hostname === hostname()) {
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        else throw e;
      }
      if (alive) throw new Error('Another notes process is running.');
    }
    await rm(lock, { recursive: true });
    await mkdir(lock, { mode: 0o700 });
  }
  await durableWrite(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: hostname() }),
  );
  const queue = new NotesQueue(join(root, 'queue.sqlite'));
  try {
    queue.recover();
    queue.recheckMissing();
    if (command === 'enqueue') {
      const filename = option('--file', '');
      const ids = filename
        ? (await readFile(filename, 'utf8')).split(/\s+/).filter(Boolean)
        : option('--ids', '').split(',').filter(Boolean);
      if (!ids.length || ids.length > 1_000_000)
        throw new Error('Provide shiur IDs.');
      queue.enqueue(ids.map((id) => ({ id })));
      console.log(JSON.stringify(queue.status()));
      return;
    }
    if (command === 'catalog') {
      const pages = integer('--pages', 20, 1, 15000);
      for (let i = 0; i < pages; i++) {
        controller.throwIfAborted();
        const page = queue.cursor('catalog');
        const result = await catalogPage(page, controller);
        const expected = Math.max(
          0,
          Math.min(30, result.total - (page - 1) * 30),
        );
        if (result.docs.length !== expected)
          throw new Error('Incomplete catalog page; cursor was not advanced.');
        const records = result.docs.map((raw) => {
          const scalar = (v: unknown): string => {
            if (Array.isArray(v)) return scalar(v[0]);
            return typeof v === 'string' || typeof v === 'number'
              ? String(v)
              : '';
          };
          return {
            id: scalar(raw.shiurID ?? raw.shiurid),
            title: scalar(raw.shiurTitle ?? raw.shiurtitle).replace(
              /<[^>]*>/g,
              '',
            ),
            teacher: scalar(raw.teacherfullname),
          };
        });
        queue.enqueue(records);
        queue.setCursor('catalog', page + 1);
        console.log(
          JSON.stringify({ page, total: result.total, queued: records.length }),
        );
        if (page * 30 >= result.total) break;
        await delay(1000, undefined, { signal: controller });
      }
      return;
    }
    const credential = JSON.parse(
      await readFile(
        resolve(option('--credential', join(root, 'writer.json'))),
        'utf8',
      ),
    ) as NotesCredential;
    const store = new TiDBNotesStore(credential);
    const limit = args.includes('--all')
      ? Infinity
      : integer('--limit', 3, 1, 1000);
    if (command === 'restore') {
      let restored = 0;
      for (const id of await readdir(join(root, 'notes'))) {
        if (restored >= limit) break;
        if (!/^[1-9]\d{0,11}$/.test(id)) continue;
        const folder = join(root, 'notes', id);
        const metadata = JSON.parse(
          await readFile(join(folder, 'metadata.json'), 'utf8'),
        );
        await store.publish({
          ...metadata,
          gzip: new Uint8Array(await readFile(join(folder, 'notes.md.gz'))),
        });
        restored++;
        console.log(JSON.stringify({ id, status: 'restored' }));
      }
      return;
    }
    if (command !== 'run') throw new Error('Unknown command.');
    const config = {
      executable: option(
        '--opencode',
        process.env.OPENCODE_EXECUTABLE ?? 'opencode-notes',
      ),
      scratch: join(root, 'scratch'),
    };
    const assetRoot =
      process.env.NOTES_ASSET_ROOT ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const transcriptionSkill = await readFile(
      join(
        assetRoot,
        'packages/transcription/skills/lectern-transcription/SKILL.md',
      ),
      'utf8',
    );
    const notesSkill = await readFile(
      join(assetRoot, 'packages/transcription/skills/lectern-notes/SKILL.md'),
      'utf8',
    );
    const profile = notesProfile({
      model: FREE_NOTES_MODEL,
      language: 'hebrewEnglish',
      runtime: openCodeIdentity(config),
      transcriptionSkill,
      notesSkill,
    });
    const cleanRuntime = async (scratch: string) => {
      for (const name of await readdir(scratch).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return [];
          throw e;
        },
      )) {
        if (name.startsWith('opencode-'))
          await recoverOpenCode(
            { ...config, scratch },
            join(scratch, name),
            controller,
          );
      }
    };
    const pipeline = new NotesPipeline({
      root,
      queue,
      store,
      signal: controller,
      language: 'hebrewEnglish',
      generatorVersion: profile.id,
      cleanupRuntime: cleanRuntime,
      generate: async (source, job) => {
        const result = await generateNotes({
          profile,
          source,
          signal: controller,
          saveCleaned: async () => {},
          request: async (prompt) =>
            withOpenCode(
              { ...config, scratch: join(root, 'jobs', job.id, 'acp') },
              controller,
              async (client, workspace) => {
                await client.session(workspace, FREE_NOTES_MODEL);
                return client.textPrompt(prompt);
              },
            ),
        });
        return result.markdown;
      },
    });
    let processed = 0;
    while (processed < limit && !controller.aborted) {
      queue.recheckMissing();
      const job = queue.claim();
      if (!job) {
        if (!args.includes('--follow')) break;
        await delay(60_000, undefined, { signal: controller });
        continue;
      }
      try {
        const status = await pipeline.process(job);
        processed++;
        console.log(JSON.stringify({ id: job.id, status, processed }));
      } catch (e) {
        const error = e as Error & {
          code?: string;
          status?: number;
          retryAfterMs?: number;
        };
        // Logs omit remote SQL/messages, credentials, prompts and source text.
        const code =
          error.code ??
          (error.status ? `database_${error.status}` : 'processing_failed');
        if (/conflict|checksum|version/i.test(error.message)) {
          queue.blocked(job.id, code);
          console.log(JSON.stringify({ id: job.id, status: 'blocked', code }));
          processed++;
          continue;
        }
        const after = Math.max(
          error.retryAfterMs ?? 0,
          Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(job.attempts, 9)),
        );
        queue.retry(job.id, code, after);
        console.log(
          JSON.stringify({
            id: job.id,
            status: 'retry',
            code,
            retryAfterMs: after,
          }),
        );
        if (controller.aborted) break;
        if (!args.includes('--follow')) {
          process.exitCode = 1;
          break;
        }
        // Pause all work on provider/database failures rather than hammering the quota.
        await delay(after, undefined, { signal: controller });
      }
      if (!controller.aborted)
        await delay(integer('--pace-ms', 2000, 1000, 60000), undefined, {
          signal: controller,
        });
    }
    console.log(JSON.stringify({ jobs: queue.status() }));
  } finally {
    queue.close();
    await rm(lock, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(
    e?.name === 'AbortError'
      ? 'Stopped; progress is saved.'
      : 'Pipeline stopped. Check configuration or run status.',
  );
  process.exitCode = 1;
});
