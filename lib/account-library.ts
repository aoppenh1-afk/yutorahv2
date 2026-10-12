import { restoreLibrary, type LibraryState } from './library';
import type { Shiur } from './yutorah';

export type LibraryRow = {
  key: string;
  value: unknown;
  deleted: boolean;
  version: number;
  operation: string;
};
export type LibraryChange = Omit<LibraryRow, 'version'> & {
  base_version: number;
  modified?: number;
};
export type LibraryReply = {
  items: LibraryRow[];
  resolved: LibraryRow[];
  revision: number;
  has_more: boolean;
  conflicts: string[];
};
export type LibraryTransport = (
  changes: LibraryChange[],
  since: number,
) => Promise<LibraryReply>;
export type LibraryStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const libraryOwnerKey = 'yutorah-library-owner';
export const libraryCacheKey = (id: string) => 'yutorah-cloud-library-' + id;
type Values = Record<string, unknown>;

/** Store recording metadata once, and keep independently editable items separate. */
export function libraryValues(library: LibraryState): Values {
  const values: Values = {};
  const recording = (shiur: Shiur) => {
    values['recording:' + shiur.id] = shiur;
    return shiur.id;
  };
  library.saved.forEach((s, index) => {
    values['saved:' + s.id] = { id: recording(s), index };
  });
  for (const { shiur, ...progress } of library.history)
    values['history:' + shiur.id] = { ...progress, shiurId: recording(shiur) };
  for (const playlist of library.playlists) {
    values['playlist:' + playlist.id] = {
      id: playlist.id,
      name: playlist.name,
    };
    playlist.items.forEach((s, index) => {
      values['playlist-item:' + playlist.id + ':' + s.id] = {
        playlistId: playlist.id,
        shiurId: recording(s),
        index,
      };
    });
  }
  for (const { shiur, ...note } of library.notes) {
    if (shiur) recording(shiur);
    values['note:' + note.id] = note;
  }
  for (const follow of library.following)
    if (follow.kind !== 'teacher')
      values['follow:' + follow.kind + ':' + follow.id] = follow;
  for (const id of library.hidden) values['hidden:' + id] = id;
  for (const id of library.completed) values['completed:' + id] = id;
  for (const search of library.savedSearches)
    values['search:' + search.id] = search;
  for (const [day, seconds] of Object.entries(library.learningDays))
    values['day:' + day] = seconds;
  values.queue = library.queue.map(recording);
  values.last = library.last ? recording(library.last) : null;
  for (const key of ['speed', 'defaultSpeed', 'volume', 'dailyGoal'] as const)
    values['preference:' + key] = library[key];
  return values;
}

export function valuesLibrary(
  values: Values,
  teachers: LibraryState['following'] = [],
): LibraryState {
  const source = restoreLibrary(null);
  const recording = (id: number) =>
    values['recording:' + id] as Shiur | undefined;
  const entries = <T>(prefix: string) =>
    Object.entries(values)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, v]) => v as T);
  const saved = entries<{ id: number; index: number }>('saved:').sort(
    (a, b) => a.index - b.index || b.id - a.id,
  );
  const history = entries<{
    shiurId: number;
    seconds: number;
    duration: number;
    updatedAt: string;
  }>('history:')
    .map(({ shiurId, ...progress }) => ({
      ...progress,
      shiur: recording(shiurId),
    }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const members = entries<{
    playlistId: string;
    shiurId: number;
    index: number;
  }>('playlist-item:');
  const playlists = entries<{ id: string; name: string }>('playlist:').map(
    (p) => ({
      ...p,
      items: members
        .filter((m) => m.playlistId === p.id)
        .sort((a, b) => a.index - b.index || a.shiurId - b.shiurId)
        .map((m) => recording(m.shiurId)),
    }),
  );
  const queue = Array.isArray(values.queue)
    ? values.queue.map((id) => recording(Number(id)))
    : [];
  return restoreLibrary({
    ...source,
    saved: saved.map((s) => recording(s.id)),
    history,
    playlists,
    notes: entries<LibraryState['notes'][number]>('note:').map((note) => ({
      ...note,
      shiur: recording(note.shiurId),
    })),
    queue,
    last: recording(Number(values.last)) ?? null,
    following: [
      ...teachers.filter((f) => f.kind === 'teacher'),
      ...entries<LibraryState['following'][number]>('follow:'),
    ],
    hidden: entries<number>('hidden:'),
    completed: entries<number>('completed:'),
    savedSearches: entries<LibraryState['savedSearches'][number]>('search:'),
    learningDays: Object.fromEntries(
      Object.entries(values)
        .filter(([key]) => key.startsWith('day:'))
        .map(([key, v]) => [key.slice(4), v]),
    ),
    ...Object.fromEntries(
      Object.entries(values)
        .filter(([key]) => key.startsWith('preference:'))
        .map(([key, v]) => [key.slice(11), v]),
    ),
  });
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Cache = {
  rows: Record<string, LibraryRow>;
  pending: Record<string, LibraryChange>;
  revision: number;
  imported: boolean;
};
/** A durable per-account outbox. Version checks prevent stale tabs from reviving deletions. */
export class AccountLibrary {
  private cache: Cache = {
    rows: {},
    pending: {},
    revision: 0,
    imported: false,
  };
  private view: LibraryState;
  private active = true;
  private running: Promise<void> | null = null;
  private device: string;
  private lastStored: string | null = null;
  private acknowledged = new Set<string>();
  constructor(
    private id: string,
    private storage: LibraryStorage,
    private transport: LibraryTransport,
    private render: (library: LibraryState) => void,
    private status: (pending: number, syncing: boolean, error: string) => void,
    local: LibraryState,
    importLocal: boolean,
    deviceId?: string,
    localOwned = false,
  ) {
    this.device =
      deviceId ||
      storage.getItem('yutorah-library-device') ||
      crypto.randomUUID();
    storage.setItem('yutorah-library-device', this.device);
    try {
      this.lastStored = storage.getItem(libraryCacheKey(id));
      const cache = JSON.parse(this.lastStored || 'null');
      if (cache?.rows && cache?.pending && Number.isSafeInteger(cache.revision))
        this.cache = cache;
    } catch {
      /* Invalid cache is rebuilt from the account. */
    }
    this.view = this.library(local.following);
    if (!this.cache.imported) {
      if (importLocal) this.observe(local);
      this.cache.imported = true;
      this.persist();
    } else if (importLocal && localOwned) this.observe(local);
    else if (importLocal) {
      // Guest data can add items to a returning account, but an empty signed-out
      // view must never remove that account's cached library or preferences.
      const values = libraryValues(this.view);
      const defaults = libraryValues(restoreLibrary(null));
      for (const [key, value] of Object.entries(libraryValues(local)))
        if (
          !key.startsWith('day:') &&
          !this.cache.rows[key] &&
          !this.cache.pending[key] &&
          !same(value, defaults[key])
        )
          values[key] = value;
      this.observe(valuesLibrary(values, local.following));
    }
    this.publish(local.following);
  }
  private persist() {
    const stored = this.storage.getItem(libraryCacheKey(this.id));
    if (stored && stored !== this.lastStored) {
      try {
        const other = JSON.parse(stored) as Cache;
        for (const row of Object.values(other.rows))
          if ((this.cache.rows[row.key]?.version ?? -1) < row.version)
            this.cache.rows[row.key] = row;
        for (const change of Object.values(other.pending)) {
          if (
            this.acknowledged.has(change.operation) ||
            this.cache.rows[change.key]?.operation === change.operation
          )
            continue;
          if (
            !this.cache.pending[change.key] ||
            (change.modified ?? 0) >
              (this.cache.pending[change.key].modified ?? 0) ||
            ((change.modified ?? 0) ===
              (this.cache.pending[change.key].modified ?? 0) &&
              change.operation > this.cache.pending[change.key].operation)
          )
            this.cache.pending[change.key] = change;
        }
        this.cache.revision = Math.max(this.cache.revision, other.revision);
      } catch {
        /* Keep this tab's durable edits if another cache is malformed. */
      }
    }
    for (const change of Object.values(this.cache.pending))
      if (this.cache.rows[change.key]?.operation === change.operation)
        delete this.cache.pending[change.key];
    const sorted = <T>(items: Record<string, T>) =>
      Object.fromEntries(
        Object.entries(items).sort(([a], [b]) => a.localeCompare(b)),
      );
    const value = JSON.stringify({
      ...this.cache,
      rows: sorted(this.cache.rows),
      pending: sorted(this.cache.pending),
    });
    this.storage.setItem(libraryCacheKey(this.id), value);
    this.lastStored = value;
  }
  reload() {
    if (this.active) {
      this.persist();
      this.publish();
    }
  }
  private library(teachers: LibraryState['following']) {
    const values: Values = {};
    for (const row of Object.values(this.cache.rows))
      if (!row.deleted) values[row.key] = row.value;
    for (const change of Object.values(this.cache.pending)) {
      if (change.deleted) delete values[change.key];
      else values[change.key] = change.value;
    }
    // Each device owns a monotonic listening counter; totals sum across devices.
    // Legacy imports share a counter so the same copied library is not doubled.
    for (const [key, value] of Object.entries({ ...values })) {
      if (!key.startsWith('day:')) continue;
      delete values[key];
      const day = key.slice(0, 14);
      values[day] = Number(values[day] || 0) + Number(value);
    }
    return valuesLibrary(values, teachers);
  }
  private publish(teachers = this.view.following) {
    if (!this.active) return;
    this.view = this.library(teachers);
    this.render(this.view);
  }
  get pendingCount() {
    return Object.keys(this.cache.pending).length;
  }
  observe(next: LibraryState) {
    if (!this.active) return;
    const previous = libraryValues(this.view);
    const values = libraryValues(next);
    for (const key of new Set([
      ...Object.keys(previous),
      ...Object.keys(values),
    ])) {
      // Metadata may still be referenced on another device. Never remove it on
      // a local collection deletion; memberships carry their own tombstones.
      if (!(key in values) && key.startsWith('recording:')) continue;
      if (same(previous[key], values[key])) continue;
      // Upload this device's absolute contribution, making retries idempotent.
      const delta = key.startsWith('day:')
        ? Math.max(0, Number(values[key] || 0) - Number(previous[key] || 0))
        : null;
      if (delta === 0) continue;
      const target =
        delta === null
          ? key
          : key + ':' + (this.cache.imported ? this.device : 'legacy');
      const pending = this.cache.pending[target];
      this.cache.pending[target] = {
        key: target,
        value:
          delta === null
            ? (values[key] ?? null)
            : Number(pending?.value ?? this.cache.rows[target]?.value ?? 0) +
              delta,
        deleted: !(key in values),
        base_version: this.cache.rows[target]?.version ?? 0,
        operation: crypto.randomUUID(),
        modified: Date.now(),
      };
    }
    this.view = next;
    this.persist();
    this.status(this.pendingCount, !!this.running, '');
  }
  private accept(rows: LibraryRow[], sent: LibraryChange[]) {
    for (const row of rows) {
      const old = this.cache.rows[row.key];
      if (old && old.version > row.version) continue;
      this.cache.rows[row.key] = row;
      const pending = this.cache.pending[row.key];
      const submitted = sent.find((c) => c.key === row.key);
      if (pending && row.key.startsWith('history:') && !row.deleted) {
        const incoming = pending.value as LibraryState['history'][number];
        const existing = row.value as LibraryState['history'][number];
        if (Date.parse(incoming.updatedAt) > Date.parse(existing.updatedAt)) {
          pending.base_version = row.version;
          if (
            submitted &&
            pending.operation === submitted.operation &&
            row.operation !== submitted.operation
          )
            pending.operation = crypto.randomUUID();
        }
      }
      if (
        pending &&
        submitted &&
        pending.operation !== submitted.operation &&
        row.operation === submitted.operation
      ) {
        pending.base_version = row.version;
      }
    }
  }
  sync(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.running) return this.running;
    const work = async () => {
      this.status(this.pendingCount, true, '');
      try {
        let more = true;
        let pulling = true;
        while (this.active && (more || this.pendingCount)) {
          const sent = pulling
            ? []
            : Object.values(this.cache.pending).slice(0, 250);
          const reply = await this.transport(sent, this.cache.revision);
          if (!this.active) return;
          this.accept([...reply.items, ...reply.resolved], sent);
          for (const change of sent)
            if (
              this.cache.pending[change.key]?.operation === change.operation
            ) {
              delete this.cache.pending[change.key];
              this.acknowledged.add(change.operation);
              if (this.acknowledged.size > 1024)
                this.acknowledged.delete(
                  this.acknowledged.values().next().value!,
                );
            }
          this.cache.revision = reply.revision;
          more = reply.has_more;
          pulling = pulling && more;
          this.persist();
          this.publish();
        }
        this.status(this.pendingCount, false, '');
      } catch (e) {
        if (this.active)
          this.status(
            this.pendingCount,
            false,
            e instanceof Error
              ? e.message
              : 'Your library could not sync. Your changes remain on this device.',
          );
      }
    };
    this.running = work().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  stop() {
    this.active = false;
  }
}
