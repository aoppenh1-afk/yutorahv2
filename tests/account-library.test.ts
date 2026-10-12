import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountLibrary,
  libraryValues,
  valuesLibrary,
  type LibraryRow,
  type LibraryTransport,
} from '../lib/account-library';
import { restoreLibrary } from '../lib/library';
import type { Shiur } from '../lib/yutorah';

const shiur = (id: number): Shiur => ({
  id,
  title: 'Shiur ' + id,
  teacher: 'Teacher',
  teacherId: 1,
  topics: [],
  duration: 300,
  audio: 'https://example.test/' + id + '.mp3',
  image: '',
  url: '',
  date: '2026-10-11',
  category: '',
  language: 'English',
  series: '',
  seriesId: 0,
  description: '',
  format: 'audio',
  materials: [],
});
const clone = <T>(value: T): T => structuredClone(value);
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}
function server() {
  const rows = new Map<string, LibraryRow>();
  let revision = 0;
  const transport: LibraryTransport = async (changes, since) => {
    const resolved: LibraryRow[] = [];
    const conflicts: string[] = [];
    for (const change of changes) {
      const current = rows.get(change.key);
      if (current?.operation !== change.operation) {
        if (
          change.key.startsWith('day:') &&
          Number(current?.value || 0) >= Number(change.value)
        ) {
          /* Counter retry. */
        } else if (
          !change.key.startsWith('day:') &&
          (current?.version ?? 0) !== change.base_version
        )
          conflicts.push(change.key);
        else
          rows.set(change.key, {
            key: change.key,
            value: clone(change.value),
            deleted: change.deleted,
            operation: change.operation,
            version: ++revision,
          });
      }
      const row = rows.get(change.key);
      if (row) resolved.push(clone(row));
    }
    const all = [...rows.values()]
      .filter((row) => row.version > since)
      .sort((a, b) => a.version - b.version);
    const items = all.slice(0, 1000);
    return {
      items: clone(items),
      resolved,
      revision: all.length > 1000 ? items.at(-1)!.version : revision,
      has_more: all.length > 1000,
      conflicts,
    };
  };
  return { rows, transport };
}
function device(
  transport: LibraryTransport,
  local = restoreLibrary(null),
  cache = storage(),
  id = 'account',
  importLocal = true,
) {
  let view = local;
  let status = { pending: 0, syncing: false, error: '' };
  const controller = new AccountLibrary(
    id,
    cache,
    transport,
    (next) => {
      view = next;
    },
    (pending, syncing, error) => {
      status = { pending, syncing, error };
    },
    local,
    importLocal,
  );
  return {
    controller,
    cache,
    get view() {
      return view;
    },
    get status() {
      return status;
    },
  };
}

void test('every study-library field round trips, with recording metadata stored once', () => {
  const s = shiur(1);
  const local = restoreLibrary({
    saved: [s],
    history: [
      {
        shiur: s,
        seconds: 80,
        duration: 300,
        updatedAt: '2026-10-11T00:00:00Z',
      },
    ],
    playlists: [{ id: 'playlist', name: 'Learning', items: [s] }],
    notes: [
      {
        id: 'note',
        shiur: s,
        shiurId: 1,
        seconds: 30,
        text: 'My private note',
        date: '2026-10-11',
      },
    ],
    queue: [s],
    last: s,
    speed: 1.5,
    defaultSpeed: 1.25,
    volume: 0.5,
    dailyGoal: 30,
    learningDays: { '2026-10-11': 60 },
    following: [{ kind: 'topic', id: 4, name: 'Halacha' }],
    hidden: [9],
    completed: [10],
    savedSearches: [
      {
        id: 'search',
        name: 'Review',
        query: 'Shabbos',
        filters: { teacher: '1' },
        createdAt: '2026-10-11',
      },
    ],
  });
  const values = libraryValues(local);
  assert.equal(
    Object.keys(values).filter((k) => k.startsWith('recording:')).length,
    1,
  );
  assert.deepEqual(valuesLibrary(values), local);
});

void test('first sign-in imports a device library and another device restores it', async () => {
  const cloud = server();
  const a = device(
    cloud.transport,
    restoreLibrary({
      saved: [shiur(1)],
      playlists: [{ id: 'one', name: 'First', items: [shiur(1)] }],
    }),
  );
  await a.controller.sync();
  const b = device(cloud.transport);
  await b.controller.sync();
  assert.deepEqual(
    b.view.saved.map((s) => s.id),
    [1],
  );
  assert.equal(b.view.playlists[0].name, 'First');
  assert.equal(a.status.pending, 0);
});

void test('concurrent playlist additions merge and stale imports cannot revive saved-item deletions', async () => {
  const cloud = server();
  const local = restoreLibrary({
    saved: [shiur(1)],
    playlists: [{ id: 'one', name: 'First', items: [] }],
  });
  const a = device(cloud.transport, local);
  await a.controller.sync();
  const b = device(cloud.transport);
  await b.controller.sync();
  a.controller.observe({
    ...a.view,
    saved: [],
    playlists: [{ ...a.view.playlists[0], items: [shiur(2)] }],
  });
  b.controller.observe({
    ...b.view,
    playlists: [{ ...b.view.playlists[0], items: [shiur(3)] }],
  });
  await a.controller.sync();
  await b.controller.sync();
  await a.controller.sync();
  assert.deepEqual(
    a.view.playlists[0].items.map((s) => s.id).sort((a, b) => a - b),
    [2, 3],
  );
  const stale = device(cloud.transport, local);
  await stale.controller.sync();
  assert.deepEqual(stale.view.saved, []);
});

void test('offline edits survive reload and changes during an in-flight save are retained', async () => {
  const cloud = server();
  const cache = storage();
  const offline = device(
    async () => {
      throw Error('offline');
    },
    restoreLibrary({ saved: [shiur(1)] }),
    cache,
  );
  await offline.controller.sync();
  assert.equal(offline.status.error, 'offline');
  offline.controller.stop();
  const recovered = device(cloud.transport, offline.view, cache);
  await recovered.controller.sync();
  assert.equal(recovered.view.saved.length, 1);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = device(async (changes, since) => {
    await gate;
    return cloud.transport(changes, since);
  });
  slow.controller.observe({ ...slow.view, volume: 0.2 });
  const saving = slow.controller.sync();
  slow.controller.observe({ ...slow.view, volume: 0.7 });
  release!();
  await saving;
  assert.equal(slow.view.volume, 0.7);
  assert.equal(slow.status.pending, 0);
});

void test('listening time adds across devices and a lost response cannot double-count', async () => {
  const cloud = server();
  let fail = true;
  const a = device(async (changes, since) => {
    const r = await cloud.transport(changes, since);
    if (fail) {
      fail = false;
      throw Error('lost response');
    }
    return r;
  });
  a.controller.observe({ ...a.view, learningDays: { '2026-10-11': 20 } });
  await a.controller.sync();
  await a.controller.sync();
  const b = device(cloud.transport);
  await b.controller.sync();
  b.controller.observe({ ...b.view, learningDays: { '2026-10-11': 50 } });
  await b.controller.sync();
  await a.controller.sync();
  assert.equal(a.view.learningDays['2026-10-11'], 50);
});

void test('another account starts empty and a cancelled request cannot render private data', async () => {
  const cloud = server();
  const cache = storage();
  const a = device(
    cloud.transport,
    restoreLibrary({
      notes: [
        {
          id: 'private',
          shiurId: 1,
          seconds: 0,
          text: 'Private',
          date: '2026-10-11',
        },
      ],
    }),
    cache,
    'A',
  );
  await a.controller.sync();
  const b = device(server().transport, a.view, cache, 'B', false);
  assert.deepEqual(b.view.notes, []);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancelled = device(async (changes, since) => {
    await gate;
    return cloud.transport(changes, since);
  });
  const request = cancelled.controller.sync();
  cancelled.controller.stop();
  release!();
  await request;
  assert.deepEqual(cancelled.view.notes, []);
});

void test('same-browser tabs preserve each other’s durable pending edits', async () => {
  const cloud = server();
  const cache = storage();
  const a = device(cloud.transport, restoreLibrary(null), cache);
  await a.controller.sync();
  const b = device(cloud.transport, restoreLibrary(null), cache);
  a.controller.observe({ ...a.view, saved: [shiur(1)] });
  b.controller.observe({
    ...b.view,
    notes: [
      {
        id: 'note',
        shiurId: 1,
        seconds: 0,
        text: 'Keep this too',
        date: '2026-10-11',
      },
    ],
  });
  a.controller.reload();
  await a.controller.sync();
  b.controller.reload();
  await b.controller.sync();
  assert.equal(a.view.saved.length, 1);
  assert.equal(b.view.saved.length, 1);
  assert.equal(b.view.notes.length, 1);
});

void test('newer listening progress from an existing device survives initial import', async () => {
  const cloud = server();
  const progress = (seconds: number, updatedAt: string) =>
    restoreLibrary({
      history: [{ shiur: shiur(1), seconds, duration: 300, updatedAt }],
    });
  const a = device(cloud.transport, progress(80, '2026-10-11T10:00:00Z'));
  await a.controller.sync();
  const newer = device(cloud.transport, progress(30, '2026-10-11T11:00:00Z'));
  await newer.controller.sync();
  assert.equal(
    newer.view.history[0].seconds,
    30,
    'The most recent position can be a rewind',
  );
});

void test('large libraries finish every read page and write batch', async () => {
  const cloud = server();
  const local = restoreLibrary({
    saved: Array.from({ length: 600 }, (_, i) => shiur(i + 1)),
  });
  const a = device(cloud.transport, local);
  await a.controller.sync();
  const b = device(cloud.transport);
  await b.controller.sync();
  assert.equal(b.view.saved.length, 600);
  assert.equal(b.status.pending, 0);
});

void test('signing back in after an empty guest session preserves the account library', async () => {
  const cloud = server();
  const cache = storage();
  const a = device(
    cloud.transport,
    restoreLibrary({
      saved: [shiur(1)],
      volume: 0.4,
      notes: [
        {
          id: 'private',
          shiurId: 1,
          seconds: 0,
          text: 'Keep my note',
          date: '2026-10-11',
        },
      ],
    }),
    cache,
  );
  await a.controller.sync();
  a.controller.stop();
  const returned = device(cloud.transport, restoreLibrary(null), cache);
  await returned.controller.sync();
  assert.equal(returned.view.saved.length, 1);
  assert.equal(returned.view.notes.length, 1);
  assert.equal(returned.view.volume, 0.4);
});

void test('continuous progress batches storage writes without dropping other collections', async () => {
  const cloud = server();
  const cache = storage();
  let writes = 0;
  const tracked = {
    getItem: cache.getItem,
    setItem: (key: string, value: string) => {
      writes++;
      cache.setItem(key, value);
    },
  };
  const a = device(
    cloud.transport,
    restoreLibrary({
      saved: [shiur(1)],
      playlists: [{ id: 'one', name: 'First', items: [shiur(1)] }],
    }),
    tracked,
  );
  await a.controller.sync();
  writes = 0;
  for (let seconds = 5; seconds <= 30; seconds += 5)
    a.controller.observe(
      { ...a.view, learningDays: { '2026-10-11': seconds } },
      true,
    );
  assert.equal(
    writes,
    0,
    'Five-second playback ticks do not rewrite the entire durable cache',
  );
  a.controller.save();
  assert.equal(writes, 1);
  const recovered = device(cloud.transport, a.view, tracked);
  await recovered.controller.sync();
  assert.equal(recovered.view.saved.length, 1);
  assert.equal(recovered.view.playlists[0].items.length, 1);
  assert.equal(recovered.view.learningDays['2026-10-11'], 30);
});
