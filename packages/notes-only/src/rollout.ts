import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NotesQueue } from './queue.js';
import type { NotesPublisher } from './pipeline.js';
import { durableWrite, loadArtifact } from './artifacts.js';
import { unpackNote } from '../../../lib/tidb-notes-store.js';
import { validateQualification, type Qualification } from './qualification.js';

export const COHORT_SIZES = [100, 500, 1000] as const;
export type CohortJob = {
  id: string;
  status: string;
  source_hash: string;
  notes_hash: string;
  profile: string;
  route: string;
};
export type CohortProgress = {
  profile: string;
  size: number;
  startedAt: number;
  excludedIds?: string[];
};

/** Start boundaries survive restarts and keep successive cohorts disjoint. */
export async function pendingCohort(
  root: string,
  queue: NotesQueue,
  profile: string,
) {
  const size = COHORT_SIZES.find(
    (n) =>
      !queue.db
        .prepare('SELECT 1 FROM cohorts WHERE profile=? AND size=?')
        .get(profile, n),
  );
  if (!size) return null;
  const excludedIds: string[] = [];
  for (const row of queue.db
    .prepare(
      'SELECT size,manifest FROM cohorts WHERE profile=? AND size<? ORDER BY size',
    )
    .all(profile, size)) {
    const manifest = JSON.parse(await readFile(String(row.manifest), 'utf8'));
    if (
      manifest.profile !== profile ||
      manifest.size !== Number(row.size) ||
      !Array.isArray(manifest.verified) ||
      manifest.verified.length !== Number(row.size) ||
      manifest.verified.some(
        (entry: { id?: string }) =>
          typeof entry.id !== 'string' || !/^\d{1,12}$/.test(entry.id),
      )
    )
      throw new Error('Invalid retained cohort membership.');
    excludedIds.push(
      ...manifest.verified.map((entry: { id: string }) => entry.id),
    );
  }
  const directory = join(root, 'cohorts', profile);
  const path = join(directory, 'rollout-current.json');
  const previous = await readFile(path, 'utf8')
    .then(JSON.parse)
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  if (previous?.profile === profile && previous.size === size) {
    if (!Number.isSafeInteger(previous.startedAt) || previous.startedAt <= 0)
      throw new Error('Invalid retained rollout boundary.');
    const resumed = { ...previous, excludedIds } as CohortProgress;
    if (JSON.stringify(previous.excludedIds) !== JSON.stringify(excludedIds))
      await durableWrite(path, JSON.stringify(resumed));
    return resumed;
  }
  const latest = queue.db
    .prepare('SELECT MAX(completed_at) AS at FROM jobs')
    .get();
  const progress: CohortProgress = {
    profile,
    size,
    startedAt: Math.max(Date.now(), Number(latest?.at ?? 0) + 1),
    excludedIds,
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await durableWrite(path, JSON.stringify(progress));
  return progress;
}

export function cohortJobs(queue: NotesQueue, progress: CohortProgress) {
  const excluded = new Set(progress.excludedIds ?? []);
  const jobs = (
    queue.db
      .prepare(
        "SELECT id,status,source_hash,notes_hash,profile,route FROM jobs WHERE status='completed' AND profile=? AND route='server-high' AND completed_at>=? ORDER BY completed_at,id",
      )
      .all(progress.profile, progress.startedAt) as CohortJob[]
  ).filter((job) => !excluded.has(job.id));
  if (jobs.length > progress.size)
    throw new Error('Candidate cohort exceeded its publication bound.');
  return jobs;
}

/** Verify every immutable artifact and independently read every published row before advancing. */
export async function verifyCohort(input: {
  root: string;
  queue: NotesQueue;
  store: NotesPublisher;
  profile: string;
  jobs: CohortJob[];
  runHash: string;
}) {
  const { root, queue, store, profile, jobs } = input;
  const size = jobs.length;
  if (
    !(COHORT_SIZES as readonly number[]).includes(size) ||
    !queue.db.prepare('SELECT 1 FROM approvals WHERE profile=?').get(profile) ||
    new Set(jobs.map((j) => j.id)).size !== size
  )
    throw new Error(
      'An approved exact-profile 100/500/1000 note cohort is required.',
    );
  for (const prior of COHORT_SIZES.filter((n) => n < size))
    if (
      !queue.db
        .prepare('SELECT 1 FROM cohorts WHERE profile=? AND size=?')
        .get(profile, prior)
    )
      throw new Error(
        'Verify the preceding candidate cohort before increasing its size.',
      );
  const earlier = queue.db
    .prepare('SELECT manifest FROM cohorts WHERE profile=? AND size<?')
    .all(profile, size);
  const priorIds = new Set<string>();
  for (const row of earlier) {
    const prior = JSON.parse(await readFile(String(row.manifest), 'utf8'));
    for (const item of prior.verified) priorIds.add(item.id);
  }
  const verified = [];
  for (const job of jobs) {
    const current = queue.db
      .prepare(
        "SELECT artifact_path FROM jobs WHERE id=? AND status='completed' AND profile=? AND notes_hash=? AND source_hash=? AND route='server-high'",
      )
      .get(job.id, profile, job.notes_hash, job.source_hash);
    if (
      job.status !== 'completed' ||
      job.profile !== profile ||
      job.route !== 'server-high' ||
      !current ||
      priorIds.has(job.id)
    )
      throw new Error(
        'Cohorts require distinct verified candidate completions.',
      );
    const { note } = await loadArtifact(root, String(current.artifact_path));
    const saved = await store.get(job.id);
    if (!saved) throw new Error('Missing cohort publication.');
    await unpackNote(saved);
    if (
      saved.notesHash !== note.notesHash ||
      saved.sourceHash !== note.sourceHash ||
      saved.generatorVersion !== note.generatorVersion
    )
      throw new Error('Cohort TiDB readback conflict.');
    verified.push({
      id: job.id,
      notesHash: note.notesHash,
      sourceHash: note.sourceHash,
    });
  }
  const path = join(
    root,
    'cohorts',
    profile,
    size + '-' + Date.now() + '.json',
  );
  await mkdir(join(root, 'cohorts', profile), { recursive: true, mode: 0o700 });
  await durableWrite(
    path,
    JSON.stringify({
      at: Date.now(),
      profile,
      size,
      runHash: input.runHash,
      verified,
    }),
  );
  queue.db
    .prepare(
      'INSERT INTO cohorts VALUES(?,?,?,?) ON CONFLICT(profile,size) DO UPDATE SET manifest=excluded.manifest,verified_at=excluded.verified_at',
    )
    .run(profile, size, path, Date.now());
  return { size, verified: verified.length, manifest: path };
}

/** An explicit observation waiver allows automatic promotion only after the real cohorts pass. */
export async function promoteCompletedRollout(
  root: string,
  queue: NotesQueue,
  evidence: Qualification,
) {
  if (!evidence.waivers?.observation24h)
    throw new Error(
      'The 24-hour observation is still required for production promotion.',
    );
  const cohorts = [];
  for (const size of COHORT_SIZES) {
    const row = queue.db
      .prepare('SELECT manifest FROM cohorts WHERE profile=? AND size=?')
      .get(evidence.profile, size);
    if (!row)
      throw new Error(
        'Finish and verify every rollout cohort before promotion.',
      );
    const manifest = JSON.parse(await readFile(String(row.manifest), 'utf8'));
    if (
      manifest.profile !== evidence.profile ||
      manifest.size !== size ||
      manifest.verified.length !== size
    )
      throw new Error('Invalid retained cohort manifest.');
    cohorts.push({
      size,
      verifiedPublications: size,
      hashesVerified: true,
      manifest: String(row.manifest),
    });
  }
  const production: Qualification = {
    ...evidence,
    phase: 'production',
    cohorts,
  };
  validateQualification(production);
  await durableWrite(
    join(root, 'cohorts', evidence.profile, 'production.json'),
    JSON.stringify(production, null, 2),
  );
  queue.db
    .prepare('UPDATE approvals SET evidence=?,approved_at=? WHERE profile=?')
    .run(JSON.stringify(production), Date.now(), evidence.profile);
  return production;
}
