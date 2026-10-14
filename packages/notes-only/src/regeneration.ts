import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { NotesQueue } from './queue.js';
import type { PriorityTeacher } from './inventory.js';
import { durableWrite } from './artifacts.js';

export async function beginRegeneration(
  root: string,
  queue: NotesQueue,
  teachers: PriorityTeacher[],
  instruction: string,
) {
  await access(join(root, 'paused'));
  if (queue.cursor('regenerationStartedAt') > 1)
    throw new Error(
      'Regeneration is already configured; resuming must not reset progress.',
    );
  if (
    !instruction.trim() ||
    !teachers.length ||
    teachers.length > 100 ||
    teachers.some(
      (t) => !Number.isSafeInteger(t.id) || t.id <= 0 || !t.name.trim(),
    ) ||
    new Set(teachers.map((t) => t.id)).size !== teachers.length
  )
    throw new Error(
      'Distinct verified teachers and the user instruction are required.',
    );
  if (
    queue.db
      .prepare(
        "SELECT 1 FROM jobs WHERE lease_token IS NOT NULL OR status IN ('fetching','generating','publishing','recovering') LIMIT 1",
      )
      .get() ||
    queue.db
      .prepare("SELECT 1 FROM sessions WHERE state!='deleted' LIMIT 1")
      .get()
  )
    throw new Error(
      'Stop and reconcile all owned jobs before starting regeneration.',
    );
  const startedAt = Date.now();
  const archive = join(root, 'upgrades', 'regeneration-' + startedAt);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  queue.db.prepare('VACUUM INTO ?').run(join(archive, 'queue.sqlite'));
  const original = queue.db
    .prepare(
      "SELECT id,notes_hash,artifact_path,attempts FROM jobs WHERE status='completed' ORDER BY id",
    )
    .all();
  await durableWrite(
    join(archive, 'preserved-completions.json'),
    JSON.stringify(original),
  );
  const record = {
    startedAt,
    requestedBy: 'user',
    instruction,
    visibility: 'keep_until_replaced',
    teachers,
    originalCompleted: original.length,
    archive,
  };
  await durableWrite(
    join(archive, 'authorization.json'),
    JSON.stringify(record, null, 2),
  );
  await durableWrite(
    join(root, 'teachers.json'),
    JSON.stringify(teachers, null, 2),
  );
  queue.transaction(() => {
    queue.db.exec(
      "UPDATE jobs SET status='discovered',attempts=0,fetch_attempts=0,generation_attempts=0,publication_attempts=0,next_at=0,error=NULL,notes_hash=NULL,source_path=NULL,source_hash=NULL,source_bytes=0,artifact_path=NULL,artifact_bytes=0,profile=NULL,generator=NULL,review='approved_route',route='server-high',priority=0,eligibility='unknown',lease_token=NULL,lease_until=0,previous_stage=NULL,reserved_source=0,reserved_outbox=0,completed_at=NULL,replace_hash=NULL; DELETE FROM generation_artifacts; DELETE FROM cohorts; DELETE FROM cursors WHERE name LIKE 'teacher%';",
    );
    for (const teacher of teachers)
      queue.db
        .prepare('UPDATE jobs SET priority=2,teacher_id=? WHERE teacher=?')
        .run(teacher.id, teacher.name);
    queue.setCursor('regenerationStartedAt', startedAt);
    queue.setCursor('legacyImported', 2);
  });
  await durableWrite(
    join(root, 'regeneration.json'),
    JSON.stringify(record, null, 2),
  );
  return record;
}
