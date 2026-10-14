import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesQueue } from '../packages/notes-only/src/queue.js';
import {
  saveArtifact,
  durableWrite,
} from '../packages/notes-only/src/artifacts.js';
import { packNote, type SavedNote } from '../lib/tidb-notes-store.js';
import {
  validateQualification,
  type Qualification,
} from '../packages/notes-only/src/qualification.js';
import {
  pendingCohort,
  cohortJobs,
  verifyCohort,
  promoteCompletedRollout,
} from '../packages/notes-only/src/rollout.js';

const profile = 'a'.repeat(64);
const approval = (): Qualification => ({
  profile,
  phase: 'quality',
  reviews: [],
  concurrency: 4,
  memoryPeakBytes: 850_000_000,
  waivers: {
    humanReview: true,
    observation24h: true,
    requestedBy: 'user',
    instruction: 'Ignore the 24 hour observation and human reviews.',
    recordedAt: Date.now(),
  },
});

void test('explicit user waivers do not manufacture reviews, waive cohort verification, or silently change the default policy', () => {
  const e = approval();
  assert.doesNotThrow(() => validateQualification(e));
  assert.throws(
    () => validateQualification({ ...e, waivers: undefined }),
    /100 human/,
  );
  assert.throws(
    () =>
      validateQualification({
        ...e,
        waivers: { ...e.waivers!, instruction: '' },
      }),
    /explicit recorded user/,
  );
  assert.throws(
    () => validateQualification({ ...e, phase: 'production' }),
    /cohort/,
  );
  assert.throws(
    () =>
      validateQualification({
        ...e,
        waivers: { ...e.waivers!, humanReview: undefined },
      }),
    /100 human/,
  );
  assert.equal(e.reviews.length, 0);
  assert.equal(e.observation, undefined);
});

void test('rollout resumes its exact cohort boundary, refuses conflicting readback, and advances only after complete disjoint verification', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-rollout-'));
  const queue = new NotesQueue(join(root, 'queue.sqlite'));
  t.after(async () => {
    queue.close();
    await rm(root, { recursive: true, force: true });
  });
  const e = approval();
  queue.db
    .prepare('INSERT INTO approvals VALUES(?,?,?)')
    .run(profile, JSON.stringify(e), Date.now());
  const progress = (await pendingCohort(root, queue, profile))!;
  assert.equal(progress.size, 100);
  assert.deepEqual(await pendingCohort(root, queue, profile), progress);
  const notes = new Map<string, SavedNote>();
  for (let n = 1; n <= 100; n++) {
    const id = String(n);
    const note = await packNote({
      shiurId: id,
      sourceHash: 'b'.repeat(64),
      generatorVersion: profile,
      language: 'hebrewEnglish',
      markdown: '# Note ' + id + '\n\n## Argument\n\nComplete grounded prose.',
    });
    const path = join('artifacts', id);
    await saveArtifact(root, path, note, {
      profile,
      generator: 'test',
      route: 'server-high',
      review: 'approved_route',
      attempt: id,
    });
    queue.enqueue([{ id }]);
    queue.db
      .prepare(
        "UPDATE jobs SET status='completed',profile=?,source_hash=?,notes_hash=?,artifact_path=?,route='server-high',completed_at=? WHERE id=?",
      )
      .run(
        profile,
        note.sourceHash,
        note.notesHash,
        path,
        progress.startedAt + 1,
        id,
      );
    notes.set(id, note);
  }
  const jobs = cohortJobs(queue, progress);
  assert.equal(jobs.length, 100);
  const wrong = await packNote({
    shiurId: '100',
    sourceHash: 'b'.repeat(64),
    generatorVersion: profile,
    language: 'hebrewEnglish',
    markdown: '# Conflicting content\n\nStill valid but different.',
  });
  const store = {
    get: async (id: string) => (id === '100' ? wrong : (notes.get(id) ?? null)),
    publish: async () => {
      throw new Error('Readback must never publish.');
    },
  };
  await assert.rejects(
    verifyCohort({
      root,
      queue,
      profile,
      jobs,
      store,
      runHash: 'c'.repeat(64),
    }),
    /readback conflict/,
  );
  assert.equal(
    queue.db.prepare('SELECT COUNT(*) AS n FROM cohorts').get()?.n,
    0,
  );
  store.get = async (id: string) => notes.get(id) ?? null;
  const verified = await verifyCohort({
    root,
    queue,
    profile,
    jobs,
    store,
    runHash: 'c'.repeat(64),
  });
  assert.equal(verified.verified, 100);
  assert.equal(
    JSON.parse(await readFile(verified.manifest, 'utf8')).verified.length,
    100,
  );
  const next = (await pendingCohort(root, queue, profile))!;
  assert.equal(next.size, 500);
  assert.equal(cohortJobs(queue, next).length, 0);
  await assert.rejects(
    promoteCompletedRollout(root, queue, e),
    /every rollout cohort/,
  );
  for (const size of [500, 1000]) {
    const path = join(root, 'cohorts', profile, size + '-fixture.json');
    await durableWrite(
      path,
      JSON.stringify({
        profile,
        size,
        verified: Array.from({ length: size }, (_, i) => ({
          id: String(size * 10 + i),
        })),
      }),
    );
    queue.db
      .prepare('INSERT INTO cohorts VALUES(?,?,?,?)')
      .run(profile, size, path, Date.now());
  }
  assert.equal(await pendingCohort(root, queue, profile), null);
  await assert.rejects(
    promoteCompletedRollout(root, queue, {
      ...e,
      waivers: { ...e.waivers!, observation24h: undefined },
    }),
    /24-hour observation/,
  );
  const promoted = await promoteCompletedRollout(root, queue, e);
  assert.equal(promoted.phase, 'production');
  assert.equal(promoted.reviews.length, 0);
  assert.equal(promoted.observation, undefined);
  assert.deepEqual(
    promoted.cohorts?.map((c) => c.verifiedPublications),
    [100, 500, 1000],
  );
});
