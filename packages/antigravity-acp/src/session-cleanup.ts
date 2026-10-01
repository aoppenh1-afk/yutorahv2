import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Failure } from './errors.js';

const suffixes = ['.db-wal', '.db-shm', '.db', '.meta'];
const canonicalID = (id: string) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : null;
const directories = (profile: string) => ({
  conversations: join(profile, 'antigravity-acp/conversations'),
  brain: join(profile, 'antigravity-acp/brain'),
});

/** Lectern's UUID-scoped cleanup. Call only after the owning process has exited. */
export async function removeConversations(
  profile: string,
  ids: Iterable<string>,
): Promise<void> {
  const paths = directories(profile);
  let failed = false;
  for (const value of ids) {
    const id = canonicalID(value);
    if (!id) continue;
    for (const suffix of suffixes)
      await rm(join(paths.conversations, id + suffix), { force: true }).catch(
        () => {
          failed = true;
        },
      );
    await rm(join(paths.brain, id), { recursive: true, force: true }).catch(
      () => {
        failed = true;
      },
    );
  }
  if (failed) throw new Failure('configuration');
}

/** Recover recorded ownership after a worker crash, before sweeping its scratch. */
export async function recoverConversations(
  profile: string,
  run: string,
): Promise<void> {
  const ledger = join(run, 'sessions.json');
  const info = await stat(ledger).catch(() => null);
  if (!info?.isFile() || info.size > 64 * 1024) return;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(ledger, 'utf8'));
  } catch {
    return;
  }
  const record = value as { version?: unknown; ids?: unknown } | null;
  if (
    record?.version === 1 &&
    Array.isArray(record.ids) &&
    record.ids.length <= 1000 &&
    record.ids.every((id) => typeof id === 'string')
  )
    await removeConversations(profile, record.ids);
}

/** Lectern's idle legacy sweep; recent or unrecognized files are left alone. */
export async function pruneConversations(
  profile: string,
  olderThan = Date.now() - 86400_000,
): Promise<void> {
  const paths = directories(profile);
  const latest = new Map<string, number>();
  const files = await readdir(paths.conversations).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw new Failure('configuration');
    },
  );
  for (const name of files) {
    const suffix = suffixes.find((suffix) => name.endsWith(suffix));
    const id = suffix ? canonicalID(name.slice(0, -suffix.length)) : null;
    if (!id) continue;
    const info = await stat(join(paths.conversations, name)).catch(() => null);
    if (info) latest.set(id, Math.max(latest.get(id) ?? 0, info.mtimeMs));
  }
  for (const [id, modified] of latest) {
    if (modified >= olderThan) continue;
    const brain = await stat(join(paths.brain, id)).catch(() => null);
    if (brain && brain.mtimeMs >= olderThan) continue;
    await removeConversations(profile, [id]);
  }
}
