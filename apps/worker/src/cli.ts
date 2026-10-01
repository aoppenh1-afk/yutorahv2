import { readFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Pool } from 'pg';
import {
  prepareProfile,
  withRuntime,
  release,
  type RuntimeConfig,
} from '../../../packages/antigravity-acp/src/runtime.js';
import {
  Failure,
  failure,
} from '../../../packages/antigravity-acp/src/errors.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';
import {
  profile,
  TranscriptionStore,
} from '../../../packages/transcription/src/store.js';
import { mediaURL } from '../../../packages/yutorah-core/src/media.js';
import { runWorker, runtimeIdentity, log } from './worker.js';
import { SelectionStore, scanSelections } from './selections.js';
import { notesProfile } from '../../../packages/transcription/src/notes.js';
import { NotesStore } from '../../../packages/transcription/src/notes-store.js';
import { OperatorRuntime } from './operator-runtime.js';
import { serveOperator } from './operator-server.js';
import { serveSearch } from './search-server.js';

const [command, ...args] = process.argv.slice(2);
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort(new Failure('cancelled')));
process.once('SIGINT', () => controller.abort(new Failure('cancelled')));
process.umask(0o077);
const state = resolve(
  process.env.WORKER_STATE_DIR ?? '/var/lib/yutorah-worker',
);
const runtime: RuntimeConfig = {
  directory: resolve(
    process.env.ACP_RUNTIME_DIR ?? `/opt/antigravity-acp/${release.version}`,
  ),
  profile: join(state, 'profile'),
  scratch: join(
    state,
    ['run', 'serve-operator'].includes(command ?? '')
      ? 'scratch'
      : 'interactive',
  ),
};
const option = (name: string, fallback = '') =>
  args[args.indexOf(name) + 1] && args.includes(name)
    ? args[args.indexOf(name) + 1]
    : fallback;
let database: Pool | undefined;
function store() {
  if (!process.env.DATABASE_URL) throw new Failure('configuration');
  database ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  database.on('error', () => controller.abort(new Failure('lease_lost')));
  return new TranscriptionStore(database);
}
async function main() {
  if (
    ['auth', 'auth-check', 'probe', 'run', 'serve-operator'].includes(command)
  ) {
    if (
      process.platform !== 'linux' ||
      !['x64', 'arm64'].includes(process.arch)
    )
      throw new Failure('configuration');
    await mkdir(state, { recursive: true, mode: 0o700 });
    await prepareProfile(runtime.profile);
  }
  if (command === 'auth' || command === 'auth-check' || command === 'probe') {
    if (command === 'auth' && (!process.stdout.isTTY || !process.stdin.isTTY))
      throw new Failure('configuration');
    await withRuntime(
      runtime,
      controller.signal,
      async (client, workspace) => {
        if (command === 'probe') {
          log({ event: 'runtime_verified' });
          return;
        }
        await client.authenticate();
        const models = await client.session(workspace);
        process.stdout.write(
          JSON.stringify({ event: 'authenticated', models }) + '\n',
        );
      },
      command === 'auth'
        ? ({ url, port }) => {
            process.stdout.write(
              `On your laptop, forward the callback with:\nssh -N -L ${port}:127.0.0.1:${port} USER@VM\nThen open this URL in your browser:\n${url.href}\n`,
            );
          }
        : undefined,
    );
    return;
  }
  const db = store();
  if (command === 'migrate') {
    const client = await db.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(891733,2)');
      await client.query(
        'CREATE TABLE IF NOT EXISTS transcription_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const file of (await readdir(resolve('db/transcription')))
        .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
        .sort()) {
        const id = file.slice(0, 3);
        if (
          (
            await client.query(
              'SELECT id FROM transcription_migrations WHERE id=$1',
              [id],
            )
          ).rowCount
        )
          continue;
        const sql = await readFile(resolve('db/transcription', file), 'utf8');
        if (!sql.startsWith('BEGIN;') || !/COMMIT;\s*$/.test(sql))
          throw new Failure('configuration');
        try {
          await client.query(
            sql.replace(
              /COMMIT;\s*$/,
              `INSERT INTO transcription_migrations(id) VALUES('${id}'); COMMIT;`,
            ),
          );
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(891733,2)').catch(() => {});
      client.release();
    }
  } else if (command === 'serve-operator') {
    const operator = new OperatorRuntime(db, {
      runtime,
      transcriptionSkillPath: resolve(
        process.env.TRANSCRIPTION_SKILL_PATH ??
          'packages/transcription/skills/lectern-transcription/SKILL.md',
      ),
      notesSkillPath: resolve(
        process.env.NOTES_SKILL_PATH ??
          'packages/transcription/skills/lectern-notes/SKILL.md',
      ),
      concurrency: Number(process.env.ACP_CONCURRENCY ?? 1),
      intervalMs: Number(process.env.CATALOG_POLL_MS ?? 300_000),
    });
    await serveOperator(
      db,
      operator,
      resolve('apps/worker/public'),
      Number(process.env.OPERATOR_PORT ?? 8766),
      controller.signal,
    );
  } else if (
    ['enqueue', 'run', 'sync-now', 'backfill'].includes(command ?? '')
  ) {
    const skill = await readFile(
      resolve(
        process.env.TRANSCRIPTION_SKILL_PATH ??
          'packages/transcription/skills/lectern-transcription/SKILL.md',
      ),
      'utf8',
    );
    const settings = {
      ...defaultSettings,
      model: process.env.ACP_MODEL ?? defaultSettings.model,
    };
    const currentProfile = profile(skill, settings, runtimeIdentity());
    if (command === 'run') {
      const intervalMs = Number(process.env.CATALOG_POLL_MS ?? 300_000);
      const deepIntervalMs = Number(
        process.env.CATALOG_DEEP_POLL_MS ?? 3_600_000,
      );
      const catalogEnabled = process.env.CATALOG_ENABLED ?? 'true';
      if (
        !['true', 'false'].includes(catalogEnabled) ||
        !Number.isInteger(intervalMs) ||
        intervalMs < 60_000 ||
        !Number.isInteger(deepIntervalMs) ||
        deepIntervalMs < intervalMs
      )
        throw new Failure('configuration');
      await runWorker(
        db,
        {
          runtime,
          concurrency: Number(process.env.ACP_CONCURRENCY ?? 3),
          pollMs: 5000,
          model: settings.model,
          selectedOnly: !args.includes('--unscoped'),
          notes:
            process.env.NOTES_ENABLED === 'false'
              ? undefined
              : notesProfile({
                  model: settings.model,
                  language: settings.language,
                  runtime: runtimeIdentity(),
                  transcriptionSkill: skill,
                  notesSkill: await readFile(
                    resolve(
                      process.env.NOTES_SKILL_PATH ??
                        'packages/transcription/skills/lectern-notes/SKILL.md',
                    ),
                    'utf8',
                  ),
                }),
          catalog:
            catalogEnabled === 'true'
              ? { profile: currentProfile, intervalMs, deepIntervalMs }
              : undefined,
        },
        controller.signal,
      );
      return;
    }
    if (command === 'sync-now') {
      log({
        event: 'selection_scan',
        ...(await scanSelections(db, currentProfile, controller.signal)),
      });
      return;
    }
    if (command === 'backfill') {
      const count = Number(option('--pages', '4'));
      if (!Number.isInteger(count) || count < 1 || count > 10)
        throw new Failure('configuration');
      log({
        event: 'selection_scan',
        ...(await scanSelections(db, currentProfile, controller.signal, count)),
      });
      return;
    }
    const id = args[0];
    if (!/^\d{1,12}$/.test(id ?? '')) throw new Failure('configuration');
    const audio = option('--audio-url');
    const job = await db.enqueue(
      {
        id,
        title: option('--title', `YU Torah shiur ${id}`),
        teacher: option('--teacher'),
        mediaUrl: audio ? mediaURL(audio).href : undefined,
        sourceRevision: option('--revision') || undefined,
      },
      currentProfile,
      args.includes('--backfill') ? -10 : 0,
    );
    log({ event: 'enqueued', job });
  } else if (command === 'targets') {
    process.stdout.write(
      JSON.stringify(await new SelectionStore(db.pool).targets(), null, 2) +
        '\n',
    );
  } else if (command === 'serve-search') {
    await serveSearch(
      db,
      process.env.TRANSCRIPT_API_TOKEN ?? '',
      Number(process.env.TRANSCRIPT_API_PORT ?? 8765),
      controller.signal,
    );
  } else if (command === 'cancel') await db.cancel(args[0]);
  else if (command === 'retry') await db.retry(args[0]);
  else if (command === 'retry-notes')
    await new NotesStore(db.pool).retry(args[0]);
  else if (command === 'search')
    process.stdout.write(
      JSON.stringify(
        await db.search(
          args.filter((a) => a !== '--literal').join(' '),
          !args.includes('--literal'),
        ),
        null,
        2,
      ) + '\n',
    );
  else if (command === 'status') {
    const result = await db.pool.query(
      'SELECT id,shiur_id,status,attempt,error,created_at,lease_until FROM transcription_jobs ORDER BY created_at DESC LIMIT 50',
    );
    process.stdout.write(JSON.stringify(result.rows, null, 2) + '\n');
  } else throw new Failure('configuration');
}
const requestedShutdown = () =>
  controller.signal.aborted &&
  controller.signal.reason instanceof Failure &&
  controller.signal.reason.code === 'cancelled';
let reportedFailure = false;
try {
  await main();
} catch (error) {
  if (!requestedShutdown()) {
    log({
      event: 'worker_stopped',
      code: controller.signal.aborted
        ? failure(controller.signal.reason).code
        : failure(error).code,
    });
    process.exitCode = 1;
    reportedFailure = true;
  }
} finally {
  if (!reportedFailure && controller.signal.aborted && !requestedShutdown()) {
    log({
      event: 'worker_stopped',
      code: failure(controller.signal.reason).code,
    });
    process.exitCode = 1;
  }
  await database?.end();
}
