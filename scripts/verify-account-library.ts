import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { notificationCredentials } from './notification-admin.mjs';
import {
  AccountLibrary,
  type LibraryReply,
  type LibraryTransport,
} from '../lib/account-library';
import { restoreLibrary } from '../lib/library';
import type { Shiur } from '../lib/yutorah';

const c = await notificationCredentials();
const admin = createClient(c.projectUrl, c.serviceRoleKey, {
  auth: { persistSession: false },
});
const users: string[] = [];
async function user() {
  const email = 'library-test-' + crypto.randomUUID() + '@example.invalid',
    password = crypto.randomUUID() + crypto.randomUUID();
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user)
    throw Error(created.error?.message || 'Fixture creation failed');
  users.push(created.data.user.id);
  const client = createClient(c.projectUrl, c.anonKey, {
    auth: { persistSession: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const transport: LibraryTransport = async (p_changes, p_since) => {
    const result = await client.rpc('sync_account_library', {
      p_changes,
      p_since,
    });
    if (result.error) throw Error(result.error.message);
    return result.data as LibraryReply;
  };
  return { id: created.data.user.id, client, transport };
}
function device(
  id: string,
  transport: LibraryTransport,
  local = restoreLibrary(null),
) {
  let view = local;
  let error = '';
  const cache = new Map<string, string>();
  const sync = new AccountLibrary(
    id,
    {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => {
        cache.set(key, value);
      },
    },
    transport,
    (next) => {
      view = next;
    },
    (_pending, _syncing, message) => {
      error = message;
    },
    local,
    true,
  );
  return {
    sync,
    get view() {
      return view;
    },
    get error() {
      return error;
    },
  };
}
try {
  const a = await user(),
    b = await user();
  const s: Shiur = {
    id: 42,
    title: 'Disposable library fixture',
    teacher: 'Fixture',
    teacherId: 1,
    topics: [],
    duration: 300,
    audio: 'https://example.invalid/fixture.mp3',
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
  };
  const local = restoreLibrary({
    saved: [s],
    playlists: [{ id: 'fixture', name: 'My playlist', items: [s] }],
    notes: [
      {
        id: 'note',
        shiur: s,
        shiurId: s.id,
        seconds: 12,
        text: 'Private note',
        date: '2026-10-11',
      },
    ],
    history: [
      {
        shiur: s,
        seconds: 80,
        duration: 300,
        updatedAt: new Date().toISOString(),
      },
    ],
    queue: [s],
    last: s,
    defaultSpeed: 1.5,
    volume: 0.4,
    hidden: [2],
    completed: [3],
    savedSearches: [
      {
        id: 'search',
        name: 'Review',
        query: 'Shabbos',
        filters: {},
        createdAt: new Date().toISOString(),
      },
    ],
    following: [
      { kind: 'topic', id: 4, name: 'Topic' },
      { kind: 'series', id: 5, name: 'Series' },
      {
        kind: 'venue',
        id: 439,
        name: 'Venue',
        image: 'https://example.invalid/venue.jpg',
      },
      {
        kind: 'collection',
        id: 15353,
        name: 'Collection',
        image: 'https://example.invalid/collection.jpg',
      },
    ],
    dailyGoal: 30,
    learningDays: { '2026-10-11': 60 },
  });
  const first = device(a.id, a.transport, local);
  await first.sync.sync();
  assert.equal(first.error, '');
  const second = device(a.id, a.transport);
  await second.sync.sync();
  assert.equal(second.error, '');
  assert.deepEqual(
    second.view,
    local,
    'The complete account library restores on a new device',
  );
  const other = device(b.id, b.transport);
  await other.sync.sync();
  assert.deepEqual(other.view.saved, []);
  assert.deepEqual(other.view.notes, []);
  assert.deepEqual(
    other.view.following,
    [],
    'Follows belong to the signed-in account',
  );
  const privateRead = await b.client.from('library_items').select('key');
  assert.equal(privateRead.error, null);
  assert.deepEqual(privateRead.data, []);
  const forbidden = await b.client.from('library_items').insert({
    user_id: a.id,
    key: 'saved:999',
    version: 1,
    operation: crypto.randomUUID(),
    value: { id: 999, index: 0 },
  });
  assert.ok(forbidden.error, 'Direct writes cannot bypass the RPC');
  first.sync.observe({
    ...first.view,
    following: first.view.following.filter(
      (f) => f.kind !== 'venue' && f.kind !== 'collection',
    ),
  });
  await first.sync.sync();
  await second.sync.sync();
  assert.deepEqual(
    second.view.following.map((f) => f.kind).sort(),
    ['series', 'topic'],
    'Unfollows sync to another device',
  );
  const staleFollows = device(a.id, a.transport, local);
  await staleFollows.sync.sync();
  assert.deepEqual(
    staleFollows.view.following.map((f) => f.kind).sort(),
    ['series', 'topic'],
    'Offline imports cannot revive deleted follows',
  );
  second.sync.observe({
    ...second.view,
    following: [
      ...second.view.following,
      { kind: 'venue', id: 439, name: 'Venue' },
      { kind: 'collection', id: 15353, name: 'Collection' },
    ],
  });
  await second.sync.sync();
  await first.sync.sync();
  assert.deepEqual(
    first.view.following.map((f) => f.kind).sort(),
    ['collection', 'series', 'topic', 'venue'],
    'An intentional refollow syncs',
  );
  const invalidFollow = await a.client.rpc('sync_account_library', {
    p_changes: [
      {
        key: 'follow:venue:123',
        value: { kind: 'collection', id: 123, name: 'Mismatch' },
        deleted: false,
        base_version: 0,
        operation: crypto.randomUUID(),
      },
    ],
    p_since: 0,
  });
  assert.match(invalidFollow.error?.message || '', /Invalid library follow/);
  first.sync.observe({ ...first.view, saved: [] });
  await first.sync.sync();
  const stale = device(a.id, a.transport, local);
  await stale.sync.sync();
  assert.deepEqual(
    stale.view.saved,
    [],
    'Stale imports preserve cloud deletions',
  );
  second.sync.observe({
    ...second.view,
    notes: [{ ...second.view.notes[0], text: 'Edited on another device' }],
  });
  await second.sync.sync();
  await first.sync.sync();
  assert.equal(first.view.notes[0].text, 'Edited on another device');
  first.sync.observe({ ...first.view, learningDays: { '2026-10-11': 80 } });
  await first.sync.sync();
  await second.sync.sync();
  second.sync.observe({ ...second.view, learningDays: { '2026-10-11': 110 } });
  await second.sync.sync();
  await first.sync.sync();
  assert.equal(first.view.learningDays['2026-10-11'], 110);
  const anonymous = createClient(c.projectUrl, c.anonKey, {
    auth: { persistSession: false },
  });
  assert.ok(
    (await anonymous.rpc('sync_account_library', { p_changes: [], p_since: 0 }))
      .error,
    'Anonymous sync is forbidden',
  );
  console.log(
    'Live library checks passed: all catalog follows restore across devices, unfollow/refollow, private accounts, invalid follow rejection, full library restore, stale deletions, notes, counters and RPC-only writes.',
  );
} finally {
  for (const id of users) {
    const result = await admin.auth.admin.deleteUser(id);
    assert.equal(result.error, null, 'Disposable account cleanup succeeds');
  }
  console.log('Removed disposable library accounts and their data.');
}
