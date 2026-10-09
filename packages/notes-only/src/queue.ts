import { DatabaseSync } from 'node:sqlite';
export type NoteJob = {
  id: string;
  title: string;
  teacher: string;
  attempts: number;
};
/** Local durable queue. The runner holds an exclusive process lock before recovery. */
export class NotesQueue {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, title TEXT NOT NULL, teacher TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT, notes_hash TEXT);
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,next_at);
      CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
  }
  recover() {
    this.db.exec("UPDATE jobs SET status='queued' WHERE status='running'");
  }
  enqueue(items: Array<{ id: string; title?: string; teacher?: string }>) {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO jobs(id,title,teacher) VALUES(?,?,?)',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        if (!/^[1-9]\d{0,11}$/.test(item.id))
          throw new Error('Invalid shiur ID.');
        insert.run(
          item.id,
          (item.title ?? `Shiur ${item.id}`).slice(0, 1000),
          (item.teacher ?? '').slice(0, 300),
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  claim(now = Date.now()): NoteJob | null {
    return (
      (this.db
        .prepare(
          "UPDATE jobs SET status='running', attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE status='queued' AND next_at <= ? ORDER BY rowid LIMIT 1) RETURNING id,title,teacher,attempts",
        )
        .get(now) as NoteJob | undefined) ?? null
    );
  }
  completed(id: string, hash: string) {
    this.db
      .prepare(
        "UPDATE jobs SET status='completed',notes_hash=?,error=NULL WHERE id=?",
      )
      .run(hash, id);
  }
  retry(id: string, error: string, afterMs: number) {
    this.db
      .prepare("UPDATE jobs SET status='queued',error=?,next_at=? WHERE id=?")
      .run(error.slice(0, 100), Date.now() + afterMs, id);
  }
  blocked(id: string, error: string) {
    this.db
      .prepare("UPDATE jobs SET status='blocked',error=? WHERE id=?")
      .run(error.slice(0, 100), id);
  }
  missing(id: string) {
    this.db
      .prepare(
        "UPDATE jobs SET status='missing',next_at=?,error=NULL WHERE id=?",
      )
      .run(Date.now() + 7 * 86400_000, id);
  }
  recheckMissing() {
    this.db
      .prepare(
        "UPDATE jobs SET status='queued' WHERE status='missing' AND next_at<=?",
      )
      .run(Date.now());
  }
  cursor(name: string) {
    return Number(
      (
        this.db.prepare('SELECT value FROM cursors WHERE name=?').get(name) as
          | { value: number }
          | undefined
      )?.value ?? 1,
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
  close() {
    this.db.close();
  }
}
