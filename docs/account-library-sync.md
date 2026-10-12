# Account library sync

Google accounts sync saved shiurim, playlists and membership order, recently
listened shiurim and resume positions, personal notes, the queue and last shiur,
topic and series follows, hidden and completed items, saved searches, learning
goals and activity, and playback preferences. Teacher follows and notification
preferences remain in the existing notification tables. Push permissions and
device subscriptions remain specific to each device. Recordings themselves are
not copied into Supabase.

`202610110008_account_library.sql` adds private `library_profiles` and
`library_items` tables. Deploy this migration before the frontend. Row-level
security permits reading only the authenticated account; clients write through
`sync_account_library`, which derives its account from `auth.uid()`. The RPC
serializes account updates, compares each item's version, retains deletion
tombstones, returns incremental changes in pages, and bounds each batch to 250
writes. Requests are pinned to the initiating account before authorization so a
sign-in change cannot send the previous account's data under the new session.

First sign-in imports the existing device library once. New devices may import
their own existing items; cloud versions and tombstones win over stale imports.
Switching accounts loads that account's cached/cloud library. Legacy device
libraries belonging to another account are archived locally rather than
imported. Signing out clears the visible account library. Offline edits persist
in an account-specific outbox and retry on reconnect, focus, or a visible-tab
poll every minute. Interactive changes debounce for 700ms, while continuous
listening updates upload at most every 30 seconds. Background tabs stop polling.

Different items merge independently. Playlist members have their own rows, so
two devices can add different shiurim without replacing one another. Concurrent
edits to the same item keep the newer cloud version. Listening-time counters
belong to each tab/device and add together. Legacy time imports share a counter;
repeated uploads cannot count time twice. Recording metadata is stored once per
account and retained when a collection is removed, since another device may
still reference it.

The migration does not alter notification or search tables and does not enable
paid services. A 10MiB logical account limit and 64KiB per-item limit bound cloud
storage; failures retain local edits and show a retry/error message. The existing
local collection limits still apply. Total Supabase free-plan capacity remains
finite; this feature does not purchase additional capacity automatically.

Validation: `npx tsx --test tests/account-library.test.ts` covers migration,
offline/reload recovery, simultaneous playlist additions, stale deletions,
in-flight edits, account switching, time counters, and same-browser tabs.
`tests/account-library-db.test.ts` checks the SQL against disposable PostgreSQL.
`scripts/verify-account-library.ts` uses disposable live Supabase accounts and
removes its fixtures, checking the actual RPC, account isolation and stale edits.
