import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import {
  Failure,
  checkAbort,
  failure,
} from '../../../packages/antigravity-acp/src/errors.js';
import {
  TranscriptionStore,
  transaction,
  type Profile,
} from '../../../packages/transcription/src/store.js';
import { catalogPage } from '../../../packages/yutorah-core/src/media.js';
import { catalogRecords } from './catalog.js';

export type Target = {
  id: string;
  kind: 'teacher' | 'series';
  upstream_id: string;
  name: string;
  teacher_filter: string | null;
  enabled: boolean;
  recording_limit: number;
  next_page: number;
  page_offset: number;
  archive_complete: boolean;
  upstream_total: number | null;
  imported: number;
  last_scan_at: string | null;
  error: string | null;
};
export type OperatorSettings = {
  model: string;
  notes_enabled: boolean;
  worker_enabled: boolean;
};
export class SelectionStore {
  constructor(readonly pool: Pool) {}
  async targets(): Promise<Target[]> {
    return (
      await this.pool.query<Target>(
        `SELECT t.*,(SELECT count(*)::int FROM transcription_target_jobs j WHERE j.target_id=t.id) AS imported FROM transcription_targets t ORDER BY created_at`,
      )
    ).rows;
  }
  async saveTarget(input: {
    kind: Target['kind'];
    upstreamId: string;
    name: string;
    limit: number;
    enabled: boolean;
    teacherId?: string;
  }) {
    if (
      !['teacher', 'series'].includes(input.kind) ||
      !/^\d{1,12}$/.test(input.upstreamId) ||
      !input.name.trim() ||
      input.name.length > 300 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 10000 ||
      typeof input.enabled !== 'boolean'
    )
      throw new Failure('configuration');
    if (
      input.teacherId &&
      (input.kind !== 'series' || !/^\d{1,12}$/.test(input.teacherId))
    )
      throw new Failure('configuration');
    await transaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`selection-setting:${input.kind}:${input.upstreamId}`],
      );
      const previous = (
        await client.query<Target>(
          'SELECT * FROM transcription_targets WHERE kind=$1 AND upstream_id=$2 FOR UPDATE',
          [input.kind, input.upstreamId],
        )
      ).rows[0];
      if (previous && previous.teacher_filter !== (input.teacherId || null)) {
        // Narrowing a series must also remove its old queue ownership.
        await client.query(
          'DELETE FROM transcription_target_jobs WHERE target_id=$1',
          [previous.id],
        );
      }
      await client.query(
        `INSERT INTO transcription_targets(id,kind,upstream_id,name,recording_limit,enabled,teacher_filter) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(kind,upstream_id) DO UPDATE SET name=EXCLUDED.name,recording_limit=EXCLUDED.recording_limit,enabled=EXCLUDED.enabled,teacher_filter=EXCLUDED.teacher_filter,next_page=CASE WHEN transcription_targets.teacher_filter IS DISTINCT FROM EXCLUDED.teacher_filter THEN 1 ELSE transcription_targets.next_page END,page_offset=CASE WHEN transcription_targets.teacher_filter IS DISTINCT FROM EXCLUDED.teacher_filter THEN 0 ELSE transcription_targets.page_offset END,archive_complete=CASE WHEN transcription_targets.teacher_filter IS DISTINCT FROM EXCLUDED.teacher_filter THEN false ELSE transcription_targets.archive_complete END,error=NULL`,
        [
          randomUUID(),
          input.kind,
          input.upstreamId,
          input.name.trim(),
          input.limit,
          input.enabled,
          input.teacherId || null,
        ],
      );
    });
  }
  async settings(): Promise<OperatorSettings> {
    return (
      await this.pool.query<OperatorSettings>(
        'SELECT model,notes_enabled,worker_enabled FROM transcription_operator_settings WHERE id=1',
      )
    ).rows[0];
  }
  async saveSettings(s: OperatorSettings) {
    if (
      !/^[a-zA-Z0-9._:-]{1,120}$/.test(s.model) ||
      typeof s.notes_enabled !== 'boolean' ||
      typeof s.worker_enabled !== 'boolean'
    )
      throw new Failure('configuration');
    await this.pool.query(
      'UPDATE transcription_operator_settings SET model=$1,notes_enabled=$2,worker_enabled=$3 WHERE id=1',
      [s.model, s.notes_enabled, s.worker_enabled],
    );
  }
  async snapshot() {
    const [targets, settings, jobs, totals] = await Promise.all([
      this.targets(),
      this.settings(),
      this.pool
        .query(`SELECT j.id,j.shiur_id,h.title,h.teacher,j.status,j.attempt,j.error,j.created_at,j.completed_at,
        EXISTS(SELECT 1 FROM transcription_target_jobs tj JOIN transcription_targets t ON t.id=tj.target_id WHERE tj.job_id=j.id AND t.enabled) AS eligible,
        (SELECT count(*)::int FROM transcription_chunks c WHERE c.job_id=j.id) AS chunks,
        n.id AS notes_id,n.status AS notes_status,n.error AS notes_error
        FROM transcription_jobs j JOIN transcription_shiurim h ON h.id=j.shiur_id
        LEFT JOIN LATERAL(SELECT id,status,error FROM notes_jobs WHERE transcript_id=h.active_transcript_id ORDER BY created_at DESC LIMIT 1) n ON true
        ORDER BY j.created_at DESC LIMIT 100`),
      this.pool.query(
        `SELECT status,count(*)::int AS count FROM transcription_jobs j
         WHERE status<>'queued' OR EXISTS(SELECT 1 FROM transcription_target_jobs tj JOIN transcription_targets t ON t.id=tj.target_id WHERE tj.job_id=j.id AND t.enabled)
         GROUP BY status`,
      ),
    ]);
    return { targets, settings, jobs: jobs.rows, totals: totals.rows };
  }
}

/** Verify the upstream filter before accepting audio, including co-teachers. */
export function belongsToTarget(
  raw: Record<string, unknown>,
  target: Pick<Target, 'kind' | 'upstream_id'> &
    Partial<Pick<Target, 'teacher_filter'>>,
): boolean {
  if (target.kind === 'teacher') {
    const teachers = Array.isArray(raw.shiurTeachers) ? raw.shiurTeachers : [];
    return (
      teachers.some(
        (t) =>
          t &&
          String((t as Record<string, unknown>).teacherID) ===
            target.upstream_id,
      ) || String(raw.teacherid ?? raw.teacherID) === target.upstream_id
    );
  }
  const series = raw.shiurSeries ?? raw.seriesid;
  return (
    (Array.isArray(series) ? series : [series]).some(
      (id) => String(id) === target.upstream_id,
    ) &&
    (!target.teacher_filter ||
      belongsToTarget(raw, {
        kind: 'teacher',
        upstream_id: target.teacher_filter,
      }))
  );
}

/** Cursor and budget are durable; duplicate/overlapping selections share one job. */
export async function scanSelections(
  store: TranscriptionStore,
  p: Profile,
  signal: AbortSignal,
  pagesPerTarget = 2,
  fetchPage = catalogPage,
) {
  const selection = new SelectionStore(store.pool);
  let accepted = 0;
  for (const target of await selection.targets()) {
    checkAbort(signal);
    if (!target.enabled || target.imported >= target.recording_limit) continue;
    const lock = await store.pool.connect();
    const key = `yutorah-target:${target.id}`;
    let locked = false;
    try {
      locked = (
        await lock.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',
          [key],
        )
      ).rows[0].ok;
      if (!locked) continue;
      let pageNumber = target.archive_complete ? 1 : target.next_page;
      let offset = target.archive_complete ? 0 : target.page_offset;
      for (let pageIndex = 0; pageIndex < pagesPerTarget; pageIndex++) {
        checkAbort(signal);
        const current = (await selection.targets()).find(
          (t) => t.id === target.id,
        );
        if (
          !current?.enabled ||
          current.teacher_filter !== target.teacher_filter ||
          current.imported >= current.recording_limit
        )
          break;
        const page = await fetchPage(pageNumber, signal, {
          kind: target.kind,
          upstreamId: target.upstream_id,
          ...(target.teacher_filter
            ? { teacherId: target.teacher_filter }
            : {}),
        });
        const afterFetch = (await selection.targets()).find(
          (t) => t.id === target.id,
        );
        if (
          !afterFetch?.enabled ||
          afterFetch.teacher_filter !== target.teacher_filter
        )
          break;
        if (page.docs.some((raw) => !belongsToTarget(raw, target)))
          throw new Failure('download');
        // Validate chronological ordering once, including non-audio records.
        catalogRecords(page.docs);
        let budgetReached = false;
        for (let index = offset; index < page.docs.length; index++) {
          checkAbort(signal);
          const audio = catalogRecords([page.docs[index]]).records[0];
          if (audio) {
            const current = (await selection.targets()).find(
              (t) => t.id === target.id,
            );
            if (
              !current?.enabled ||
              current.teacher_filter !== target.teacher_filter ||
              current.imported >= current.recording_limit
            ) {
              budgetReached = true;
              break;
            }
            const jobId = await store.enqueue(
              {
                id: audio.id,
                title: audio.title,
                teacher: audio.teacher,
                mediaUrl: audio.mediaUrl,
                sourceRevision: audio.sourceRevision,
              },
              p,
            );
            await transaction(store.pool, async (client) => {
              const currentTarget = (
                await client.query<Target>(
                  'SELECT * FROM transcription_targets WHERE id=$1 FOR UPDATE',
                  [target.id],
                )
              ).rows[0];
              if (
                !currentTarget.enabled ||
                currentTarget.teacher_filter !== target.teacher_filter
              ) {
                budgetReached = true;
                return;
              }
              const count = (
                await client.query<{ count: number }>(
                  'SELECT count(*)::int AS count FROM transcription_target_jobs WHERE target_id=$1',
                  [target.id],
                )
              ).rows[0].count;
              if (count >= currentTarget.recording_limit) {
                budgetReached = true;
                return;
              }
              const added = await client.query(
                'INSERT INTO transcription_target_jobs(target_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
                [target.id, jobId],
              );
              accepted += added.rowCount ?? 0;
              await client.query(
                'UPDATE transcription_targets SET next_page=$2,page_offset=$3,upstream_total=$4,last_scan_at=now(),error=NULL WHERE id=$1',
                [target.id, pageNumber, index + 1, page.total],
              );
            });
            if (budgetReached) break;
          } else {
            await store.pool.query(
              'UPDATE transcription_targets SET next_page=$2,page_offset=$3,upstream_total=$4,last_scan_at=now(),error=NULL WHERE id=$1 AND enabled AND teacher_filter IS NOT DISTINCT FROM $5',
              [
                target.id,
                pageNumber,
                index + 1,
                page.total,
                target.teacher_filter,
              ],
            );
          }
        }
        if (budgetReached) break;
        const exhausted = pageNumber * 30 >= page.total || !page.docs.length;
        await store.pool.query(
          'UPDATE transcription_targets SET next_page=$2,page_offset=0,archive_complete=$3,upstream_total=$4,last_scan_at=now(),error=NULL WHERE id=$1 AND enabled AND teacher_filter IS NOT DISTINCT FROM $5',
          [
            target.id,
            exhausted ? 1 : pageNumber + 1,
            exhausted,
            page.total,
            target.teacher_filter,
          ],
        );
        if (exhausted) break;
        pageNumber++;
        offset = 0;
      }
    } catch (error) {
      checkAbort(signal);
      await store.pool.query(
        'UPDATE transcription_targets SET error=$2,last_scan_at=now() WHERE id=$1 AND teacher_filter IS NOT DISTINCT FROM $3',
        [target.id, failure(error).code, target.teacher_filter],
      );
      throw error;
    } finally {
      if (locked)
        await lock
          .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key])
          .catch(() => {});
      lock.release();
    }
  }
  return { accepted };
}
export async function pollSelections(
  store: TranscriptionStore,
  p: Profile,
  signal: AbortSignal,
  intervalMs: number,
  onEvent: (value: { event: string; code?: string; accepted?: number }) => void,
) {
  while (!signal.aborted) {
    try {
      onEvent({
        event: 'selection_scan',
        ...(await scanSelections(store, p, signal)),
      });
    } catch (error) {
      if (signal.aborted) break;
      onEvent({ event: 'selection_scan_failed', code: failure(error).code });
    }
    try {
      await delay(intervalMs, undefined, { signal });
    } catch {
      break;
    }
  }
}
