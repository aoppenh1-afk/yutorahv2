import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const QUEUE_VERSION = 2;
export type Stage = 'fetching' | 'generating' | 'publishing';
export type NoteJob = {
  id: string;
  title: string;
  teacher: string;
  status: string;
  attempts: number;
  fetch_attempts: number;
  generation_attempts: number;
  publication_attempts: number;
  source_path: string | null;
  source_hash: string | null;
  source_bytes: number;
  artifact_path: string | null;
  notes_hash: string | null;
  artifact_bytes: number;
  profile: string | null;
  generator: string | null;
  review: string;
  route: string;
  eligibility: string;
  lease_token: string;
  lease_until: number;
  previous_stage: Stage | null;
  priority: number;
  next_at: number;
  error: string | null;
  replace_hash: string | null;
  teacher_id: number;
  ready_at: number | null;
  redo_reason: string | null;
};
const waiting: Record<Stage, string> = {
  fetching: 'discovered',
  generating: 'ready',
  publishing: 'generated',
};
const columns = {
  fetch_attempts: 'INTEGER NOT NULL DEFAULT 0',
  generation_attempts: 'INTEGER NOT NULL DEFAULT 0',
  publication_attempts: 'INTEGER NOT NULL DEFAULT 0',
  source_path: 'TEXT',
  source_hash: 'TEXT',
  source_bytes: 'INTEGER NOT NULL DEFAULT 0',
  artifact_path: 'TEXT',
  artifact_bytes: 'INTEGER NOT NULL DEFAULT 0',
  profile: 'TEXT',
  generator: 'TEXT',
  review: "TEXT NOT NULL DEFAULT 'approved_route'",
  route: "TEXT NOT NULL DEFAULT 'acp-high'",
  priority: 'INTEGER NOT NULL DEFAULT 0',
  eligibility: "TEXT NOT NULL DEFAULT 'unknown'",
  lease_token: 'TEXT',
  lease_until: 'INTEGER NOT NULL DEFAULT 0',
  previous_stage: 'TEXT',
  reserved_source: 'INTEGER NOT NULL DEFAULT 0',
  reserved_outbox: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL DEFAULT 0',
  completed_at: 'INTEGER',
  replace_hash: 'TEXT',
  teacher_id: 'INTEGER NOT NULL DEFAULT 0',
  ready_at: 'INTEGER',
  redo_reason: 'TEXT',
};

/** One coordinator owns mutations. Asynchronous completions are fenced by renewable leases. */
export class NotesQueue {
  readonly db: DatabaseSync;
  constructor(filename: string, readonlyMode = false) {
    this.db = new DatabaseSync(filename, { readOnly: readonlyMode });
    this.db.exec('PRAGMA busy_timeout=5000;');
    if (readonlyMode) return;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.transaction(() => {
      const version = Number(
        this.db.prepare('PRAGMA user_version').get()?.user_version,
      );
      if (version > QUEUE_VERSION)
        throw new Error('Queue schema is newer than this runner.');
      this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, teacher TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'discovered', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, error TEXT, notes_hash TEXT);
        CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
      const existing = new Set(
        this.db
          .prepare('PRAGMA table_info(jobs)')
          .all()
          .map((x) => x.name),
      );
      for (const [name, definition] of Object.entries(columns))
        if (!existing.has(name))
          this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
      if (version < 2)
        this.db.exec(`
        UPDATE jobs SET status='discovered' WHERE status='queued';
        UPDATE jobs SET status='recovering',previous_stage='generating' WHERE status='running';`);
      this.db
        .exec(`CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,next_at);
        CREATE INDEX IF NOT EXISTS jobs_leases ON jobs(lease_until) WHERE lease_token IS NOT NULL;
        CREATE TABLE IF NOT EXISTS generation_artifacts (
          token TEXT PRIMARY KEY, job_id TEXT NOT NULL, source_hash TEXT NOT NULL,
          profile TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS backup_journal (
          path TEXT PRIMARY KEY, job_id TEXT NOT NULL, notes_hash TEXT NOT NULL, backed_up_at INTEGER);
        CREATE TABLE IF NOT EXISTS upstreams (
          name TEXT PRIMARY KEY, until_at INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, reason TEXT);
        CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL, token TEXT NOT NULL, route TEXT NOT NULL,
          kind TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL,
          reserved_tokens INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
          reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL, evidence TEXT);
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL, token TEXT NOT NULL, runtime TEXT NOT NULL,
          state TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS requests_started ON requests(started_at);
        CREATE INDEX IF NOT EXISTS requests_ended ON requests(ended_at);
        CREATE INDEX IF NOT EXISTS requests_active_job ON requests(job_id) WHERE status='active';
        CREATE INDEX IF NOT EXISTS requests_active_budget ON requests(status) WHERE status='active';
        CREATE INDEX IF NOT EXISTS sessions_live_job ON sessions(job_id,runtime) WHERE state!='deleted';
        CREATE INDEX IF NOT EXISTS sessions_live_runtime ON sessions(runtime) WHERE state!='deleted';
        CREATE INDEX IF NOT EXISTS sessions_active ON sessions(state) WHERE state='active';
        CREATE INDEX IF NOT EXISTS generation_artifacts_job_time ON generation_artifacts(job_id,created_at DESC);
        CREATE INDEX IF NOT EXISTS jobs_urgent ON jobs(status,next_at) WHERE priority>=3;
        CREATE TABLE IF NOT EXISTS language_findings (
          job_id TEXT NOT NULL, notes_hash TEXT NOT NULL, source_hash TEXT NOT NULL,
          policy TEXT NOT NULL, scope TEXT NOT NULL, verdict TEXT NOT NULL, assessment TEXT NOT NULL,
          artifact_path TEXT, detected_at INTEGER NOT NULL, queued_at INTEGER, previous_job TEXT,
          replacement_hash TEXT, replaced_at INTEGER, PRIMARY KEY(job_id,notes_hash,scope));
        CREATE TABLE IF NOT EXISTS request_observations (
          request_id TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL DEFAULT 0, detail TEXT, PRIMARY KEY(request_id,phase));
        CREATE INDEX IF NOT EXISTS request_observations_at ON request_observations(at);
        CREATE TABLE IF NOT EXISTS generation_attempts (
          token TEXT PRIMARY KEY, job_id TEXT NOT NULL, started_at INTEGER NOT NULL,
          source_chars INTEGER NOT NULL, source_seconds REAL NOT NULL,
          first_pass INTEGER, repair_codes TEXT, evidence_bytes INTEGER NOT NULL DEFAULT 0,
          normalizer TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS generation_attempts_job ON generation_attempts(job_id);
        CREATE TABLE IF NOT EXISTS quarantine_evidence (job_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, checked_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, job_id TEXT, stage TEXT NOT NULL,
          outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS events_at ON events(at);
        CREATE TABLE IF NOT EXISTS approvals (profile TEXT PRIMARY KEY, evidence TEXT NOT NULL, approved_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS reviews (notes_hash TEXT PRIMARY KEY, source_hash TEXT NOT NULL, profile TEXT NOT NULL, reviewer TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, reviewed_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cohorts (profile TEXT NOT NULL, size INTEGER NOT NULL, manifest TEXT NOT NULL, verified_at INTEGER NOT NULL, PRIMARY KEY(profile,size));
        PRAGMA user_version=2;`);
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  enqueue(
    items: Array<{ id: string; title?: string; teacher?: string }>,
    priority = 0,
  ) {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO jobs(id,title,teacher,status,priority) VALUES(?,?,?,'discovered',?)",
    );
    this.transaction(() => {
      for (const item of items) {
        if (!/^[1-9]\d{0,11}$/.test(item.id))
          throw new Error('Invalid shiur ID.');
        insert.run(
          item.id,
          (item.title ?? `Shiur ${item.id}`).slice(0, 1000),
          (item.teacher ?? '').slice(0, 300),
          priority,
        );
      }
    });
  }
  claim(
    stage: Stage,
    options: {
      now?: number;
      leaseMs?: number;
      backlog?: boolean;
      sourceReservation?: number;
      outboxReservation?: number;
      allowedIds?: string[];
      eligibilityOnly?: boolean;
    } = {},
  ): NoteJob | null {
    if (options.allowedIds?.length === 0) return null;
    const now = options.now ?? Date.now();
    const count =
      stage === 'fetching'
        ? 'fetch_attempts'
        : stage === 'generating'
          ? 'generation_attempts'
          : 'publication_attempts';
    return (
      (this.db
        .prepare(`UPDATE jobs SET status=?,lease_token=?,lease_until=?,updated_at=?,
      ${count}=${count}+1,attempts=attempts+?,reserved_source=CASE WHEN source_path IS NULL THEN ? ELSE 0 END,reserved_outbox=?
      WHERE id=(SELECT id FROM jobs WHERE ${stage === 'fetching' ? "(status=? OR (status='ready' AND eligibility='unknown'))" : 'status=?'} AND next_at<=?
        ${stage === 'generating' ? "AND eligibility='eligible'" : ''}
        ${stage === 'generating' ? "AND (priority>=3 OR NOT EXISTS(SELECT 1 FROM jobs urgent WHERE urgent.priority>=3 AND urgent.status IN ('discovered','fetching','ready','recovering') AND urgent.next_at<=?))" : ''}
        ${options.eligibilityOnly ? "AND source_path IS NOT NULL AND eligibility='unknown'" : ''}
        ${options.allowedIds ? `AND id IN (${options.allowedIds.map(() => '?').join(',')})` : ''}
        ${stage === 'publishing' ? "AND review IN ('approved_route','accepted')" : ''}
        ORDER BY CASE WHEN priority>=3 THEN 0 WHEN priority>=2 THEN 1 ELSE 2 END,${options.backlog ? 'rowid' : 'priority DESC,rowid'} LIMIT 1)
      RETURNING *`)
        .get(
          stage,
          randomUUID(),
          now + (options.leaseMs ?? 120_000),
          now,
          stage === 'generating' ? 1 : 0,
          options.sourceReservation ?? 0,
          options.outboxReservation ?? 0,
          waiting[stage],
          now,
          ...(stage === 'generating' ? [now] : []),
          ...(options.allowedIds ?? []),
        ) as NoteJob | undefined) ?? null
    );
  }
  owns(job: NoteJob, now = Date.now()) {
    return !!this.db
      .prepare(
        'SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND lease_until>?',
      )
      .get(job.id, job.lease_token, now);
  }
  renew(job: NoteJob, leaseMs: number, now = Date.now()) {
    return (
      Number(
        this.db
          .prepare(
            'UPDATE jobs SET lease_until=? WHERE id=? AND lease_token=? AND lease_until>?',
          )
          .run(now + leaseMs, job.id, job.lease_token, now).changes,
      ) === 1
    );
  }
  /** Only the live kernel-lock-owning coordinator may refresh its unchanged token after an event-loop stall. */
  heartbeat(job: NoteJob, leaseMs: number, now = Date.now()) {
    if (this.renew(job, leaseMs, now)) return true;
    const renewed = this.db
      .prepare(`UPDATE jobs SET lease_until=? WHERE id=? AND lease_token=? AND lease_until<=?
      AND status IN ('fetching','generating','publishing')`)
      .run(now + leaseMs, job.id, job.lease_token, now);
    if (Number(renewed.changes) !== 1) return false;
    this.event('lease', 'renewed_after_stall', job.id);
    return true;
  }
  finish(job: NoteJob, changes: Partial<NoteJob>, now = Date.now()) {
    const allowed = new Set([
      'status',
      'source_path',
      'source_hash',
      'source_bytes',
      'artifact_path',
      'notes_hash',
      'artifact_bytes',
      'profile',
      'generator',
      'route',
      'review',
      'eligibility',
      'error',
      'next_at',
      'replace_hash',
      'redo_reason',
    ]);
    for (const name of Object.keys(changes))
      if (!allowed.has(name)) throw new Error('Invalid checkpoint field.');
    const entries = Object.entries(changes);
    const result = this.db
      .prepare(`UPDATE jobs SET ${entries.map(([name]) => `${name}=?`).join(',')},
      lease_token=NULL,lease_until=0,previous_stage=NULL,reserved_source=0,reserved_outbox=0,updated_at=?,
      completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,
      ready_at=CASE WHEN ?='ready' THEN ? ELSE ready_at END
      WHERE id=? AND lease_token=? AND lease_until>?`)
      .run(
        ...entries.map(([, v]) => v ?? null),
        now,
        changes.status ?? '',
        now,
        changes.status ?? '',
        now,
        job.id,
        job.lease_token,
        now,
      );
    if (Number(result.changes) !== 1)
      throw Object.assign(new Error('lease_lost'), { code: 'lease_lost' });
    if (changes.artifact_path && changes.notes_hash)
      this.journal(job.id, changes.artifact_path, changes.notes_hash);
    const completedHash = changes.notes_hash ?? job.notes_hash;
    if (changes.status === 'completed' && completedHash)
      this.db
        .prepare(
          'UPDATE language_findings SET replacement_hash=?,replaced_at=? WHERE job_id=? AND notes_hash!=? AND queued_at IS NOT NULL AND replaced_at IS NULL',
        )
        .run(completedHash, now, job.id, completedHash);
  }
  accept(job: NoteJob, changes: Partial<NoteJob>) {
    this.transaction(() => this.finish(job, changes));
  }
  journal(id: string, path: string, hash: string) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO backup_journal(path,job_id,notes_hash) VALUES(?,?,?)',
      )
      .run(path, id, hash);
  }
  repairJournal() {
    this.db.exec(`INSERT OR IGNORE INTO backup_journal(path,job_id,notes_hash)
      SELECT artifact_path,id,notes_hash FROM jobs WHERE artifact_path IS NOT NULL AND notes_hash IS NOT NULL;`);
  }
  expired(now = Date.now()) {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('fetching','generating','publishing','recovering') AND lease_until<=?",
      )
      .all(now) as NoteJob[];
  }
  fence(job: NoteJob) {
    // Reconcile the old request before requeueing. Late callbacks lose ownership immediately.
    return this.db
      .prepare(`UPDATE jobs SET previous_stage=CASE WHEN status='recovering' THEN previous_stage ELSE status END,
      status='recovering',lease_token=?,lease_until=? WHERE id=? AND lease_until<=? RETURNING *`)
      .get(randomUUID(), Date.now() + 120_000, job.id, Date.now()) as
      | NoteJob
      | undefined;
  }
  recheckMissing(now = Date.now()) {
    this.db
      .prepare(
        "UPDATE jobs SET status='discovered' WHERE status='missing' AND next_at<=?",
      )
      .run(now);
  }
  cooldown(name: string, ms: number, reason: string, paused = false) {
    this.db
      .prepare(`INSERT INTO upstreams VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET
      until_at=MAX(until_at,excluded.until_at),paused=MAX(paused,excluded.paused),reason=excluded.reason`)
      .run(name, Date.now() + ms, Number(paused), reason.slice(0, 80));
  }
  resume(name: string) {
    this.db.prepare('DELETE FROM upstreams WHERE name=?').run(name);
  }
  available(name: string, now = Date.now()) {
    const row = this.db
      .prepare('SELECT * FROM upstreams WHERE name=?')
      .get(name);
    return !row || (!row.paused && Number(row.until_at) <= now);
  }
  event(stage: string, outcome: string, id: string | null, duration = 0) {
    this.db
      .prepare(
        'INSERT INTO events(at,job_id,stage,outcome,duration_ms) VALUES(?,?,?,?,?)',
      )
      .run(Date.now(), id, stage, outcome, duration);
  }
  /** No source/output text or authentication material belongs in this table. */
  observe(
    request: string,
    phase: string,
    duration = 0,
    detail: string | null = null,
  ) {
    this.db
      .prepare('INSERT OR IGNORE INTO request_observations VALUES(?,?,?,?,?)')
      .run(
        request,
        phase,
        Date.now(),
        Math.max(0, Math.round(duration)),
        detail,
      );
  }
  pruneTelemetry() {
    const before = Date.now() - 30 * 86400_000;
    this.db
      .prepare(
        'DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE at<? LIMIT 10000)',
      )
      .run(before);
    this.db
      .prepare(
        'DELETE FROM request_observations WHERE rowid IN (SELECT rowid FROM request_observations WHERE at<? LIMIT 10000)',
      )
      .run(before);
  }
  cursor(name: string) {
    return Number(
      this.db.prepare('SELECT value FROM cursors WHERE name=?').get(name)
        ?.value ?? 1,
    );
  }
  setCursor(name: string, value: number) {
    this.db
      .prepare(
        'INSERT INTO cursors VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
      )
      .run(name, value);
  }
  status() {
    return this.db
      .prepare('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status')
      .all();
  }
  usage() {
    return this.db
      .prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('ready','generating','fetching') THEN source_bytes+reserved_source ELSE 0 END),0) AS sourceBytes,
      COALESCE(SUM(CASE WHEN status IN ('ready','generating','fetching') THEN 1 ELSE 0 END),0) AS sourceCount,
      COALESCE(SUM(CASE WHEN status='generating' OR (status IN ('generated','publishing') AND review IN ('approved_route','accepted')) THEN artifact_bytes+reserved_outbox ELSE 0 END),0) AS outboxBytes,
      COALESCE(SUM(CASE WHEN status='generating' OR (status IN ('generated','publishing') AND review IN ('approved_route','accepted')) THEN 1 ELSE 0 END),0) AS outboxCount,
      COALESCE(SUM(CASE WHEN status IN ('needs_review','conflict') OR (status='generated' AND review NOT IN ('approved_route','accepted')) THEN 1 ELSE 0 END),0) AS quarantineCount,
      COALESCE(SUM(CASE WHEN status IN ('needs_review','conflict') OR (status='generated' AND review NOT IN ('approved_route','accepted')) THEN artifact_bytes+source_bytes+
        COALESCE((SELECT bytes FROM quarantine_evidence q WHERE q.job_id=jobs.id),
          (SELECT SUM(evidence_bytes) FROM generation_attempts a WHERE a.job_id=jobs.id),0) ELSE 0 END),0) AS quarantineBytes
      FROM jobs WHERE status IN ('ready','generating','fetching','generated','publishing','needs_review','conflict')`)
      .get() as Record<string, number>;
  }
  deferNormalReady() {
    return this.db
      .prepare(
        "UPDATE jobs SET status='discovered' WHERE id=(SELECT id FROM jobs WHERE status='ready' AND priority<3 AND lease_token IS NULL ORDER BY rowid DESC LIMIT 1) RETURNING id",
      )
      .get();
  }
  close() {
    this.db.close();
  }
}
