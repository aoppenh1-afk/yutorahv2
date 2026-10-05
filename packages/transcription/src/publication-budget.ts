import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export class PublicationPausedError extends Error {
  readonly resumeAt: Date;
  constructor(message: string) {
    super(message);
    const now = new Date();
    this.resumeAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
  }
}
type State = { day: string; reserved: number; size: number };
/** Conservative reservations persist across service restarts. Use one budget
 * file per D1 database and run the publisher/importer as the same service user. */
export class PublicationBudget {
  private pending = Promise.resolve();
  private size = 0;
  constructor(
    private file: string,
    private limit = 60000,
    private storageLimit = 450 * 1024 * 1024,
  ) {}
  async check(minimum = 5000) {
    let state: State;
    try {
      state = JSON.parse(await readFile(this.file, 'utf8')) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (
      state.day === new Date().toISOString().slice(0, 10) &&
      state.reserved + Math.min(minimum, this.limit / 5) > this.limit
    )
      throw new PublicationPausedError(
        'Publication daily write budget reached.',
      );
    if ((this.size || state.size) >= this.storageLimit)
      throw new PublicationPausedError('Publication storage budget reached.');
  }
  async reserve(queries: { sql: string; params: unknown[] }[]) {
    const writes = queries.filter((query) =>
      /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)/i.test(query.sql),
    );
    if (!writes.length) return;
    // Index/FTS writes count against D1's allowance too. Reserve generously,
    // including cleanup whose affected row count is not known before execution.
    const amount = writes.reduce(
      (sum, q) =>
        sum +
        (/archive_segments/i.test(q.sql)
          ? /^\s*DELETE/i.test(q.sql)
            ? 5000
            : 50 * Math.max(1, Math.ceil(q.params.length / 9))
          : /archive_spelling_keys/i.test(q.sql)
            ? 3 * Math.max(1, q.params.length / 2)
            : Math.max(10, q.params.length * 3)),
      0,
    );
    return this.charge(amount);
  }
  async observed(metas: { rows_written?: number; size_after?: number }[]) {
    for (const meta of metas) this.observe(meta);
    const actual = metas.reduce(
      (sum, meta) => sum + (meta.rows_written || 0),
      0,
    );
    if (actual > 0) await this.charge(actual, true);
  }
  private async charge(amount: number, observed = false) {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let locked = false;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const lock = await open(this.file + '.lock', 'wx', 0o600);
          await lock.close();
          locked = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await delay(100);
        }
      }
      if (!locked)
        throw new Error(
          'Publication budget is locked. Inspect the service before removing a stale lock.',
        );
      const day = new Date().toISOString().slice(0, 10);
      let state: State;
      try {
        state = JSON.parse(await readFile(this.file, 'utf8')) as State;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = { day, reserved: 0, size: 0 };
      }
      if (!Number.isFinite(state.reserved) || !Number.isFinite(state.size))
        throw new Error('Publication budget state is invalid.');
      if (state.day !== day) state = { ...state, day, reserved: 0 };
      state.size = this.size || state.size;
      if (!observed && state.size >= this.storageLimit)
        throw new PublicationPausedError('Publication storage budget reached.');
      if (!observed && state.reserved + amount > this.limit)
        throw new PublicationPausedError(
          'Publication daily write budget reached.',
        );
      state.reserved += amount;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.tmp';
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
      if (observed && state.reserved > this.limit)
        throw new PublicationPausedError(
          'Publication daily write budget reached.',
        );
    } finally {
      try {
        if (locked) await unlink(this.file + '.lock');
      } finally {
        release();
      }
    }
  }
  observe(meta: {
    rows_read?: number;
    rows_written?: number;
    size_after?: number;
  }) {
    if (meta.size_after) this.size = meta.size_after;
  }
}
const budgets = new Map<string, PublicationBudget>();
export function publicationBudget(
  databaseId: string,
  env: Record<string, string | undefined>,
) {
  const file =
    env.TRANSCRIPT_PUBLICATION_BUDGET_FILE ||
    join(homedir(), '.local/state/yutorah', `d1-${databaseId}-budget.json`);
  const limit = Number(env.TRANSCRIPT_PUBLICATION_WRITE_BUDGET || 60000);
  const storage = Number(
    env.TRANSCRIPT_PUBLICATION_STORAGE_BUDGET || 450 * 1024 * 1024,
  );
  if (
    !Number.isSafeInteger(limit) ||
    limit < 100 ||
    limit > 70000 ||
    !Number.isSafeInteger(storage) ||
    storage < 1000000 ||
    storage > 450 * 1024 * 1024
  )
    throw new Error('Invalid publication budget.');
  let budget = budgets.get(file);
  if (!budget) {
    budget = new PublicationBudget(file, limit, storage);
    budgets.set(file, budget);
  }
  return budget;
}
