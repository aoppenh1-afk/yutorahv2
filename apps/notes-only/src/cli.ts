import { mkdir, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NotesQueue } from '../../../packages/notes-only/src/queue.js';
import { NotesPipeline } from '../../../packages/notes-only/src/pipeline.js';
import {
  importLegacy,
  loadArtifact,
  digest,
  durableWrite,
} from '../../../packages/notes-only/src/artifacts.js';
import {
  runCoordinator,
  defaults,
  metrics,
  diskHeadroom,
} from '../../../packages/notes-only/src/coordinator.js';
import {
  InferenceLimiter,
  PipelineFailure,
  MAX_AI_CONCURRENCY,
} from '../../../packages/notes-only/src/control.js';
import {
  priorityInventoryPage,
  type PriorityTeacher,
} from '../../../packages/notes-only/src/inventory.js';
import { beginRegeneration } from '../../../packages/notes-only/src/regeneration.js';
import { auditNotesLanguage } from '../../../packages/notes-only/src/language-audit.js';
import { recheckSavedNotes } from '../../../packages/notes-only/src/recheck.js';
import { NOTES_LANGUAGE_POLICY } from '../../../packages/notes-only/src/language.js';
import { backupArtifacts } from '../../../packages/notes-only/src/backup.js';
import {
  notesProfile,
  generateNotes,
  NOTES_NORMALIZER,
} from '../../../packages/notes-only/src/notes.js';
import {
  TiDBNotesStore,
  type NotesCredential,
} from '../../../lib/tidb-notes-store.js';
import {
  withOpenCode,
  recoverOpenCode,
  FREE_NOTES_MODEL,
  openCodeIdentity,
  notesAgentConfig,
} from '../../../packages/opencode-acp/src/runtime.js';
import { OpenCodeServer } from '../../../packages/opencode-acp/src/server.js';
import {
  pendingCohort,
  cohortJobs,
  verifyCohort,
  promoteCompletedRollout,
  type CohortJob,
} from '../../../packages/notes-only/src/rollout.js';
import type { Qualification } from '../../../packages/notes-only/src/qualification.js';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i >= 0 && !args[i + 1]) throw new Error(`Missing ${name}.`);
  return i < 0 ? fallback : args[i + 1];
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
const signal = abort.signal;
const log = (record: unknown) => console.log(JSON.stringify(record));
async function main() {
  if (command === 'help') {
    console.log(`Staged notes coordinator (queue v2). Node 22.13+; OpenCode 1.18.33; ${FREE_NOTES_MODEL}, plan, high only.
  enqueue --ids ID,ID | --file FILE [--priority 1]
  catalog --pages 20               Resume the verified paced catalog cursor
  migrate                          Import verified legacy notes without changing completions
  regenerate --file TEACHERS --instruction TEXT  Archive checkpoints and start fresh notes
  replacement-check                Check UPDATE rights without changing a published note
  language-audit [--apply]          Audit all published/draft notes while paused; prioritize language repairs
  recheck-saved                     Recheck urgent saved conflicts and formatting-only failures while paused; no inference
  retry --ids ID,ID                 Retry reviewed failures without an accepted artifact
  run --limit 3                    Bounded pilot, including fetching and publication
  run --all --follow --inventory   Continuous coordinated pools
  rollout --route server-high      Resume verified 100/500/1000 cohorts, then production
  status | metrics                 Read-only; never recover active leases
  backup [--audit]                 Incremental artifact backup / full integrity audit
  reclaim                          Delete backed-up completed sources after retention
  verify-cohort --file RUN          Verify exact candidate pilot rows through TiDB readback
  readback --limit 20               Independently verify completed TiDB rows against artifacts
  restore --limit 20                Republish accepted completed artifacts with insert/readback
  review --file FILE                Record exact-artifact human acceptance or rejection
  resume-route --upstream muse      Clear an inspected route pause
  runtime-check                    Verify pinned server/schema/config/zero prices; no inference
  qualification --file FILE        Validate and record human-reviewed candidate evidence
Common: --state DIR --credential FILE --opencode EXECUTABLE
Generation: --route acp-high|server-high (default acp-high), --concurrency 1..6 (default 4; hard ceiling 6)
Pools: --fetchers 3 --publishers 1 --ready-low 20 --ready-target 50 --ready-max 100
Bounds: --source-mib 1024 --outbox-mib 1024 --outbox-count 1000 --disk-reserve-mib 2048
Quarantine: --quarantine-count 10000 --quarantine-mib 1024 (separate from publishable outbox)
Admission: --min-free-memory-mib 3072 --spacing-ms 2000 --requests-per-minute 30 --tokens-per-minute 2000000
Deadlines: --request-timeout-ms 1200000 --max-runtime-ms 21600000
Candidate outputs remain local until the exact profile passes its human and operational gates.
`);
    return;
  }
  if (['status', 'metrics'].includes(command)) {
    const queue = new NotesQueue(join(root, 'queue.sqlite'), true);
    try {
      log({
        state: root,
        schema: queue.db.prepare('PRAGMA user_version').get()?.user_version,
        ...metrics(queue),
        nextCatalogPage: queue.cursor('catalog'),
      });
    } finally {
      queue.close();
    }
    return;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  // Every mutating entry, including maintenance, requires the same inherited kernel lock.
  if (process.env.YUTORAH_NOTES_LOCK_HELD !== '1')
    throw new Error(
      'Use the installed run.sh or scripts/notes.mjs; the mutation kernel lock is required.',
    );
  const lock = join(root, 'runner.lock');
  const owner = await readFile(join(lock, 'owner.json'), 'utf8')
    .then(JSON.parse)
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  if (owner?.hostname === hostname()) {
    try {
      process.kill(owner.pid, 0);
      throw new Error('Another notes process is running.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  } else if (owner)
    throw new Error(
      'Notes ownership belongs to another host; reconcile before migration.',
    );
  await rm(lock, { recursive: true, force: true });
  await mkdir(lock, { mode: 0o700 });
  await durableWrite(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: hostname() }),
  );
  const queue = new NotesQueue(join(root, 'queue.sqlite'));
  let server: OpenCodeServer | undefined;
  try {
    const teachers: PriorityTeacher[] = await readFile(
      join(root, 'teachers.json'),
      'utf8',
    )
      .then(JSON.parse)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    if (command === 'regenerate') {
      const requested: PriorityTeacher[] = JSON.parse(
        await readFile(option('--file', ''), 'utf8'),
      );
      log(
        await beginRegeneration(
          root,
          queue,
          requested,
          option('--instruction', ''),
        ),
      );
      return;
    }
    if (command === 'enqueue') {
      const file = option('--file', '');
      const ids = file
        ? (await readFile(file, 'utf8')).split(/\s+/).filter(Boolean)
        : option('--ids', '').split(',').filter(Boolean);
      if (!ids.length || ids.length > 1_000_000)
        throw new Error('Provide at most 1,000,000 numeric shiur IDs.');
      queue.enqueue(
        ids.map((id) => ({ id })),
        integer('--priority', 1, 0, 1),
      );
      log(queue.status());
      return;
    }
    if (command === 'retry') {
      const ids = option('--ids', '').split(',');
      if (!ids.length || ids.some((id) => !/^\d{1,12}$/.test(id)))
        throw new Error('Provide numeric shiur IDs.');
      let retried = 0;
      for (const id of ids)
        retried += Number(
          queue.db
            .prepare(
              "UPDATE jobs SET status=CASE WHEN source_path IS NULL THEN 'discovered' ELSE 'ready' END,next_at=0,error=NULL WHERE id=? AND status IN ('blocked','needs_review') AND artifact_path IS NULL",
            )
            .run(id).changes,
        );
      log({ retried });
      return;
    }
    if (command === 'migrate') {
      const imported = await importLegacy(root, queue);
      queue.setCursor('legacyImported', 2);
      log({ imported, jobs: queue.status() });
      return;
    }
    if (command === 'resume-route') {
      const upstream = option('--upstream', 'muse');
      if (!['muse', 'tidb', 'yutorah'].includes(upstream))
        throw new Error('Invalid upstream.');
      queue.resume(upstream);
      log({ resumed: upstream });
      return;
    }
    if (command === 'catalog') {
      for (let i = 0; i < integer('--pages', 20, 1, 15000); i++) {
        log(await priorityInventoryPage(queue, signal, teachers));
        if (queue.cursor('catalog') === 1) break;
        await delay(1000, undefined, { signal });
      }
      return;
    }
    const backupDestination = resolve(
      option('--backup-dir', join(root, '..', 'yutorah-notes-backup', 'v2')),
    );
    if (command === 'backup') {
      log(
        await backupArtifacts(
          root,
          backupDestination,
          queue,
          args.includes('--audit'),
        ),
      );
      return;
    }
    if (command === 'review') {
      const value = JSON.parse(
        await readFile(option('--file', ''), 'utf8'),
      ) as {
        reviewer: string;
        profile: string;
        notes: Array<{
          id: string;
          sourceHash: string;
          notesHash: string;
          decision: 'accepted' | 'rejected';
          reason: string;
        }>;
      };
      if (
        !value.reviewer?.trim() ||
        !Array.isArray(value.notes) ||
        value.notes.length > 10000
      )
        throw new Error(
          'A named human reviewer and bounded artifact decisions are required.',
        );
      queue.transaction(() => {
        for (const review of value.notes) {
          if (
            !['accepted', 'rejected'].includes(review.decision) ||
            !review.reason?.trim()
          )
            throw new Error('Explicit review decisions and reasons required.');
          const job = queue.db
            .prepare(
              "SELECT * FROM jobs WHERE id=? AND profile=? AND source_hash=? AND notes_hash=? AND status='needs_review' AND artifact_path IS NOT NULL",
            )
            .get(review.id, value.profile, review.sourceHash, review.notesHash);
          if (!job)
            throw new Error(
              'Review does not match a retained pending artifact.',
            );
          queue.db
            .prepare(
              'INSERT INTO reviews VALUES(?,?,?,?,?,?,?) ON CONFLICT(notes_hash) DO UPDATE SET reviewer=excluded.reviewer,decision=excluded.decision,reason=excluded.reason,reviewed_at=excluded.reviewed_at',
            )
            .run(
              review.notesHash,
              review.sourceHash,
              value.profile,
              value.reviewer,
              review.decision,
              review.reason.slice(0, 1000),
              Date.now(),
            );
          queue.db
            .prepare(
              'UPDATE jobs SET review=?,error=? WHERE id=? AND notes_hash=?',
            )
            .run(
              review.decision,
              review.decision === 'rejected' ? 'human_rejection' : null,
              review.id,
              review.notesHash,
            );
        }
      });
      log({ reviewed: value.notes.length });
      return;
    }
    if (command === 'qualification') {
      const { validateQualification } =
        await import('../../../packages/notes-only/src/qualification.js');
      const evidence: Qualification = JSON.parse(
        await readFile(option('--file', ''), 'utf8'),
      );
      validateQualification(evidence);
      if (evidence.phase === 'production')
        for (const size of [100, 500, 1000])
          if (
            !queue.db
              .prepare('SELECT 1 FROM cohorts WHERE profile=? AND size=?')
              .get(evidence.profile, size)
          )
            throw new Error(
              'Verify each local cohort through independent TiDB readback first.',
            );
      if (evidence.waivers) {
        const directory = join(root, 'authorizations');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await durableWrite(
          join(directory, Date.now() + '.json'),
          JSON.stringify(evidence, null, 2),
        );
      }
      queue.db
        .prepare(
          'INSERT INTO approvals VALUES(?,?,?) ON CONFLICT(profile) DO UPDATE SET evidence=excluded.evidence,approved_at=excluded.approved_at',
        )
        .run(evidence.profile, JSON.stringify(evidence), Date.now());
      for (const review of evidence.reviews)
        queue.db
          .prepare(
            "UPDATE jobs SET review='accepted',status='generated',error=NULL WHERE profile=? AND source_hash=? AND notes_hash=? AND status='needs_review'",
          )
          .run(
            evidence.profile,
            review.sourceHash,
            review.candidateArtifactHash,
          );
      log({ approvedProfile: evidence.profile });
      return;
    }
    const route = option('--route', 'acp-high');
    if (!['acp-high', 'server-high'].includes(route))
      throw new Error('Unsupported route.');
    const config = {
      executable: option(
        '--opencode',
        process.env.OPENCODE_EXECUTABLE ?? 'opencode-notes',
      ),
      scratch: join(root, 'runtime', 'acp'),
    };
    server = new OpenCodeServer(
      {
        executable: config.executable,
        root: join(root, 'runtime', 'server'),
        deadlineMs: integer('--request-timeout-ms', 1200_000, 1000, 7200_000),
        catalogTtlMs: integer('--catalog-ttl-ms', 60_000, 1, 300_000),
      },
      queue,
    );
    if (command === 'runtime-check') {
      await server.guard();
      log({
        runtime: 'opencode:1.18.33',
        model: FREE_NOTES_MODEL,
        effort: 'high',
        schemaVerified: true,
        zeroPricesVerified: true,
      });
      return;
    }
    if (
      ![
        'run',
        'rollout',
        'reclaim',
        'readback',
        'restore',
        'verify-cohort',
        'replacement-check',
        'language-audit',
        'recheck-saved',
      ].includes(command)
    )
      throw new Error('Unknown command.');
    const assetRoot =
      process.env.NOTES_ASSET_ROOT ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const notesSkill = await readFile(
      join(
        assetRoot,
        'packages/notes-only/skills/written-shiur-notes/SKILL.md',
      ),
      'utf8',
    );
    const profile = notesProfile({
      model: FREE_NOTES_MODEL,
      language: 'hebrewEnglish',
      runtime:
        route === 'acp-high'
          ? openCodeIdentity(config)
          : 'opencode:1.18.33:server:plan:high:v1',
      notesSkill,
    });
    const approval = queue.db
      .prepare('SELECT evidence FROM approvals WHERE profile=?')
      .get(profile.id);
    const qualification = approval
      ? JSON.parse(String(approval.evidence))
      : null;
    const isRollout = command === 'rollout';
    if (isRollout && (route !== 'server-high' || !qualification))
      throw new Error(
        'Server rollout requires explicit exact-profile approval.',
      );
    const progress =
      isRollout && qualification?.phase === 'quality'
        ? await pendingCohort(root, queue, profile.id)
        : null;
    const cohortSize = progress?.size ?? integer('--limit', 3, 1, 1000);
    if (
      !isRollout &&
      command === 'run' &&
      route === 'server-high' &&
      qualification?.phase === 'quality' &&
      (args.includes('--all') ||
        ![100, 500, 1000].includes(integer('--limit', 3, 1, 1000)))
    )
      throw new Error(
        'Quality approval permits controlled 100/500/1000 note cohorts; continuous production requires the operational gate.',
      );
    if (
      ['run', 'rollout'].includes(command) &&
      route === 'server-high' &&
      qualification?.phase === 'quality'
    ) {
      const size = cohortSize;
      for (const previous of size === 1000
        ? [100, 500]
        : size === 500
          ? [100]
          : [])
        if (
          !queue.db
            .prepare('SELECT 1 FROM cohorts WHERE profile=? AND size=?')
            .get(profile.id, previous)
        )
          throw new Error(
            'Verify the preceding candidate cohort before increasing its size.',
          );
    }
    if (isRollout && qualification?.phase === 'quality' && !progress) {
      const promoted = await promoteCompletedRollout(
        root,
        queue,
        qualification,
      );
      log({
        type: 'rollout',
        phase: promoted.phase,
        profile: profile.id,
        waivers: promoted.waivers,
      });
    }
    const identity = {
      profile: profile.id,
      generator: JSON.stringify({
        ...profile,
        runtimeConfig: notesAgentConfig(),
        normalizer: NOTES_NORMALIZER,
        languagePolicy: NOTES_LANGUAGE_POLICY,
      }),
      route: route as 'acp-high' | 'server-high',
      approved: route === 'acp-high' || !!qualification,
    };
    const credential = JSON.parse(
      await readFile(
        resolve(option('--credential', join(root, 'writer.json'))),
        'utf8',
      ),
    ) as NotesCredential;
    const store = new TiDBNotesStore(credential);
    if (command === 'replacement-check') {
      await store.verifyReplacementPermission();
      log({ replacementPermission: true, changedRows: 0 });
      return;
    }
    if (command === 'verify-cohort') {
      const runBytes = await readFile(option('--file', ''));
      const run = JSON.parse(runBytes.toString()) as {
        profile: string;
        route: string;
        jobs: CohortJob[];
      };
      if (run.route !== 'server-high')
        throw new Error('A server candidate cohort is required.');
      log(
        await verifyCohort({
          root,
          queue,
          store,
          profile: run.profile,
          jobs: run.jobs,
          runHash: digest(runBytes),
        }),
      );
      return;
    }
    if (command === 'readback' || command === 'restore') {
      const rows = queue.db
        .prepare(
          "SELECT id,artifact_path,notes_hash FROM jobs WHERE status='completed' AND artifact_path IS NOT NULL ORDER BY completed_at DESC NULLS LAST,rowid DESC LIMIT ?",
        )
        .all(integer('--limit', 20, 1, 1000));
      const verified = [];
      for (const row of rows) {
        const { note } = await loadArtifact(root, String(row.artifact_path));
        if (note.notesHash !== row.notes_hash || note.shiurId !== row.id)
          throw new Error('Completed artifact mismatch.');
        const saved =
          command === 'restore'
            ? await store.publish(note)
            : await store.get(String(row.id));
        if (
          !saved ||
          saved.notesHash !== note.notesHash ||
          saved.sourceHash !== note.sourceHash ||
          saved.generatorVersion !== note.generatorVersion
        )
          throw new Error('Independent TiDB readback conflict.');
        const { unpackNote } = await import('../../../lib/tidb-notes-store.js');
        await unpackNote(saved);
        verified.push({
          id: row.id,
          notesHash: saved.notesHash,
          sourceHash: saved.sourceHash,
        });
      }
      await durableWrite(
        join(root, 'readback-verification.json'),
        JSON.stringify({ at: Date.now(), command, verified }),
      );
      log({ command, verified: verified.length });
      return;
    }
    const concurrency = integer(
      '--concurrency',
      defaults.generators,
      1,
      MAX_AI_CONCURRENCY,
    );
    if (
      route === 'server-high' &&
      qualification &&
      concurrency > qualification.concurrency
    )
      throw new Error('Requested concurrency exceeds the qualified setting.');
    const limiter = new InferenceLimiter(queue, {
      concurrency,
      spacingMs: integer('--spacing-ms', 2000, 0, 60000),
      requestsPerMinute: integer('--requests-per-minute', 30, 1, 1000),
      tokensPerMinute: integer(
        '--tokens-per-minute',
        2000_000,
        1000,
        100_000_000,
      ),
      outputReservation: 131072,
    });
    const ownedServer = server;
    const reconcileRuntime = async (job: { id: string }) => {
      const scratch = join(root, 'jobs', job.id, 'acp');
      for (const name of await readdir(scratch).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return [];
          throw e;
        },
      ))
        if (name.startsWith('opencode-'))
          await recoverOpenCode(
            { ...config, scratch },
            join(scratch, name),
            signal,
          );
      for (const row of queue.db
        .prepare(
          "SELECT id FROM sessions WHERE job_id=? AND state!='deleted' AND runtime='acp'",
        )
        .all(job.id)) {
        // New ACP attempts use their durable per-request scratch ledgers.
        for (const attempt of await readdir(
          join(root, 'attempts', job.id),
        ).catch(() => [])) {
          const folder = join(root, 'attempts', job.id, attempt, 'acp');
          for (const name of await readdir(folder).catch(() => []))
            if (name.startsWith('opencode-'))
              await recoverOpenCode(
                { ...config, scratch: folder },
                join(folder, name),
                signal,
              );
        }
        await ownedServer.guard();
        await ownedServer.adapter.cancelAndDelete(String(row.id));
      }
      if (
        queue.db
          .prepare(
            "SELECT 1 FROM sessions WHERE job_id=? AND runtime='server' AND state!='deleted'",
          )
          .get(job.id)
      ) {
        await ownedServer.guard();
        for (const row of queue.db
          .prepare(
            "SELECT id FROM sessions WHERE job_id=? AND runtime='server' AND state!='deleted'",
          )
          .all(job.id))
          await ownedServer.adapter.cancelAndDelete(String(row.id));
      }
      queue.db
        .prepare(
          "UPDATE requests SET status='reconciled_interrupted',ended_at=? WHERE job_id=? AND status='active'",
        )
        .run(Date.now(), job.id);
    };
    const pipeline = new NotesPipeline({
      root,
      queue,
      store,
      identity,
      regenerationStartedAt:
        queue.cursor('regenerationStartedAt') > 1
          ? queue.cursor('regenerationStartedAt')
          : undefined,
      reconcileRuntime,
      generate: async (source, job, jobSignal, evidenceDir) => {
        const result = await generateNotes({
          profile,
          source,
          signal: jobSignal,
          onValidation: async (validation) => {
            await durableWrite(
              join(evidenceDir, validation.kind + '.normalized.md'),
              validation.markdown,
            );
            await durableWrite(
              join(evidenceDir, validation.kind + '.validation.json'),
              JSON.stringify({
                normalizer: validation.normalizer,
                languagePolicy: NOTES_LANGUAGE_POLICY,
                codes: validation.codes,
                changed: validation.raw !== validation.markdown,
              }),
            );
            if (validation.kind === 'generation')
              queue.db
                .prepare(
                  'UPDATE generation_attempts SET first_pass=?,repair_codes=? WHERE token=?',
                )
                .run(
                  Number(validation.codes.length === 0),
                  JSON.stringify(validation.codes),
                  job.lease_token,
                );
            for (const code of validation.codes)
              queue.event('validation', validation.kind + ':' + code, job.id);
          },
          request: async (prompt, kind) =>
            limiter.run(
              job,
              route,
              kind,
              prompt,
              jobSignal,
              async (requestID) => {
                if (route === 'acp-high') {
                  const guardAt = Date.now();
                  await ownedServer.guard(); // The current pinned runtime catalog gates ACP as well as server requests.
                  queue.observe(
                    requestID,
                    'runtime_guard',
                    Date.now() - guardAt,
                  );
                }
                await durableWrite(
                  join(evidenceDir, requestID + '.prompt.txt'),
                  prompt,
                );
                let generated;
                const capture = async (messages: unknown) =>
                  durableWrite(
                    join(evidenceDir, requestID + '.messages.json'),
                    JSON.stringify(messages),
                  );
                if (route === 'server-high')
                  generated = await ownedServer.request(
                    job,
                    requestID,
                    prompt,
                    jobSignal,
                    capture,
                  );
                else {
                  const sessionIds: string[] = [];
                  generated = await withOpenCode(
                    {
                      ...config,
                      scratch: join(evidenceDir, 'acp'),
                      onCleanup: async (ids, deleted) => {
                        for (const id of ids)
                          queue.db
                            .prepare('UPDATE sessions SET state=? WHERE id=?')
                            .run(deleted ? 'deleted' : 'uncertain', id);
                      },
                      onSession: async (id) => {
                        sessionIds.push(id);
                        queue.db
                          .prepare(
                            "INSERT INTO sessions VALUES(?,?,?,?,'active',?)",
                          )
                          .run(id, job.id, job.lease_token, 'acp', Date.now());
                      },
                    },
                    jobSignal,
                    async (client, workspace) => {
                      await client.session(workspace, FREE_NOTES_MODEL);
                      const sentAt = Date.now();
                      queue.observe(requestID, 'request_sent');
                      const response = await client.verifiedPrompt(
                        prompt,
                        ownedServer.config.deadlineMs,
                        capture,
                      );
                      queue.observe(
                        requestID,
                        'response_completed',
                        Date.now() - sentAt,
                      );
                      return response;
                    },
                  );
                  for (const id of sessionIds)
                    queue.db
                      .prepare("UPDATE sessions SET state='deleted' WHERE id=?")
                      .run(id);
                }
                await durableWrite(
                  join(evidenceDir, requestID + '.raw.txt'),
                  generated.value,
                );
                await durableWrite(
                  join(evidenceDir, requestID + '.runtime.json'),
                  JSON.stringify({
                    evidence: generated.evidence,
                    messages: generated.messages,
                  }),
                );
                return generated;
              },
            ),
        });
        return result.markdown;
      },
    });
    if (command === 'recheck-saved') {
      await readFile(join(root, 'paused'));
      await pipeline.recoverExpired();
      log(await recheckSavedNotes({ root, queue, pipeline, signal }));
      return;
    }
    if (command === 'language-audit') {
      await readFile(join(root, 'paused'));
      await pipeline.recoverExpired();
      const inventoryFile = option('--inventory', '');
      const inventory = inventoryFile
        ? JSON.parse(await readFile(resolve(inventoryFile), 'utf8')).rows
        : undefined;
      await auditNotesLanguage({
        root,
        queue,
        store,
        signal,
        inventory,
        apply: args.includes('--apply'),
        report: resolve(
          option('--report', join(root, 'audits', 'notes-language.json')),
        ),
        log,
      });
      return;
    }
    if (command === 'reclaim') {
      log({ reclaimed: await pipeline.reclaim() });
      return;
    }
    if (queue.cursor('legacyImported') !== 2) {
      await importLegacy(root, queue);
      queue.setCursor('legacyImported', 2);
    }
    const settings = {
      ...defaults,
      fetchers: integer('--fetchers', defaults.fetchers, 1, 16),
      fetchSpacingMs: integer('--fetch-spacing-ms', 250, 0, 60000),
      generators: concurrency,
      publishers: integer('--publishers', defaults.publishers, 1, 8),
      readyLow: integer('--ready-low', 20, 0, 10000),
      readyTarget: integer('--ready-target', 50, 1, 10000),
      readyMax: integer('--ready-max', 100, 1, 10000),
      sourceBytes: integer('--source-mib', 1024, 8, 102400) * 1024 ** 2,
      outboxBytes: integer('--outbox-mib', 1024, 1, 102400) * 1024 ** 2,
      outboxCount: integer('--outbox-count', 1000, 1, 100000),
      quarantineCount: integer(
        '--quarantine-count',
        defaults.quarantineCount,
        1,
        1000000,
      ),
      quarantineBytes: integer('--quarantine-mib', 1024, 1, 102400) * 1024 ** 2,
      diskReserveBytes:
        integer('--disk-reserve-mib', 2048, 1, 102400) * 1024 ** 2,
      minFreeMemoryMiB: integer('--min-free-memory-mib', 3072, 0, 100000),
    };
    const headroom = await diskHeadroom(root);
    if (headroom < settings.diskReserveBytes)
      throw new Error('Insufficient disk reserve.');
    log({
      type: 'configuration',
      profile: profile.id,
      route,
      effort: 'high',
      settings,
      sourceBytes: settings.sourceBytes,
      outboxBytes: settings.outboxBytes,
      candidateApproved: identity.approved,
    });
    const completedInCohort = progress ? cohortJobs(queue, progress) : [];
    if (progress)
      log({
        type: 'rollout',
        cohort: progress.size,
        completed: completedInCohort.length,
        profile: profile.id,
      });
    const remaining = progress
      ? progress.size - completedInCohort.length
      : null;
    const runResult =
      remaining === 0
        ? null
        : await runCoordinator({
            root,
            queue,
            pipeline,
            settings,
            signal,
            limit:
              remaining ??
              (args.includes('--all')
                ? Infinity
                : integer('--limit', 3, 1, 1000)),
            follow: args.includes('--follow'),
            maxRuntimeMs: integer(
              '--max-runtime-ms',
              21600_000,
              100,
              604800_000,
            ),
            inventory: args.includes('--inventory')
              ? () => priorityInventoryPage(queue, signal, teachers)
              : undefined,
            inventoryDuringBoundedRun: isRollout,
            maintenance: async () => {
              const audit =
                Date.now() - queue.cursor('lastBackupAudit') >= 86400_000;
              await backupArtifacts(root, backupDestination, queue, audit);
              if (audit) queue.setCursor('lastBackupAudit', Date.now());
              await pipeline.reclaim();
              await pipeline.auditQuarantine();
              queue.pruneTelemetry();
            },
            log,
            runtimeMetrics: () => ownedServer.adapter.monitor.status(),
          });
    await mkdir(join(root, 'runs'), { recursive: true, mode: 0o700 });
    await durableWrite(
      join(root, 'runs', String(Date.now()) + '.json'),
      JSON.stringify({
        at: Date.now(),
        profile: profile.id,
        route,
        settings,
        ...runResult,
      }),
    );
    log(runResult);
    if (progress) {
      const completed = cohortJobs(queue, progress);
      if (completed.length === progress.size)
        log({
          type: 'rollout',
          ...(await verifyCohort({
            root,
            queue,
            store,
            profile: profile.id,
            jobs: completed,
            runHash: digest(JSON.stringify({ progress, completed })),
          })),
        });
      else
        log({
          type: 'rollout',
          cohort: progress.size,
          completed: completed.length,
          remaining: progress.size - completed.length,
        });
    }
  } finally {
    await server?.close();
    queue.close();
    await rm(lock, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error instanceof PipelineFailure ? error.code : 'command_failed',
    }),
  );
  process.exitCode = 1;
});
