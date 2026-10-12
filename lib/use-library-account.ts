'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccountLibrary,
  libraryOwnerKey,
  libraryCacheKey,
  type LibraryReply,
} from './account-library';
import { getAccountClient } from './account-client';
import {
  restoreLibrary,
  serializeLibrary,
  type LibraryState,
  type LibrarySubscribe,
  type LibraryUpdate,
} from './library';

export function useLibraryAccount(
  userId: string | undefined,
  library: LibraryState,
  update: LibraryUpdate,
  ready: boolean,
  subscribe: LibrarySubscribe,
) {
  const [state, setState] = useState({ pending: 0, syncing: false, error: '' });
  const controller = useRef<AccountLibrary | null>(null);
  const current = useRef({ library, update });
  current.current = { library, update };
  const previousUser = useRef<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    await controller.current?.sync();
  }, []);
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    setState({ pending: 0, syncing: false, error: '' });
    if (!userId) {
      if (previousUser.current) {
        current.current.update(() => restoreLibrary(null), 'remote');
        try {
          localStorage.setItem(libraryOwnerKey, 'guest');
        } catch {
          /* Keep accounts isolated in memory. */
        }
      }
      previousUser.current = undefined;
      return;
    }
    previousUser.current = userId;
    let importLocal = false;
    try {
      const owner =
        localStorage.getItem(libraryOwnerKey) ||
        localStorage.getItem('yutorah-account-owner');
      importLocal = !owner || owner === 'guest' || owner === userId;
      let local = current.current.library;
      const archived = localStorage.getItem('yutorah-device-library-' + userId);
      if (
        !importLocal &&
        !localStorage.getItem(libraryCacheKey(userId)) &&
        archived
      ) {
        local = restoreLibrary(JSON.parse(archived));
        importLocal = true;
      }
      if (owner && owner !== 'guest' && owner !== userId)
        localStorage.setItem(
          'yutorah-device-library-' + owner,
          serializeLibrary(current.current.library),
        );
      localStorage.setItem(libraryOwnerKey, userId);
      const device =
        sessionStorage.getItem('yutorah-library-tab') || crypto.randomUUID();
      sessionStorage.setItem('yutorah-library-tab', device);
      const sync = new AccountLibrary(
        userId,
        localStorage,
        async (changes, since) => {
          const db = (await getAccountClient()).forUser(userId);
          const { data, error } = await db.rpc('sync_account_library', {
            p_changes: changes,
            p_since: since,
          });
          if (error)
            throw new Error(
              error.code === 'P0001'
                ? error.message
                : 'Your library could not sync. Your changes remain on this device.',
            );
          return data as LibraryReply;
        },
        (next) => {
          current.current.update(
            (old) => ({
              ...next,
              following: [
                ...old.following.filter((f) => f.kind === 'teacher'),
                ...next.following.filter((f) => f.kind !== 'teacher'),
              ],
            }),
            'remote',
          );
        },
        (pending, syncing, error) => {
          if (active) setState({ pending, syncing, error });
        },
        local,
        importLocal,
        device,
        owner === userId,
      );
      controller.current = sync;
      const unsubscribe = subscribe((next, mode) => {
        try {
          sync.observe(next, mode === 'progress');
        } catch {
          setState((old) => ({
            ...old,
            error:
              'Your browser could not save pending library changes. Keep this page open and retry.',
          }));
        }
        if (mode !== 'progress') {
          clearTimeout(timer);
          timer = undefined;
        }
        timer ??= setTimeout(
          () => {
            timer = undefined;
            void sync.sync();
          },
          mode === 'progress' ? 30000 : 700,
        );
      });
      const retry = () => {
        clearTimeout(timer);
        if (!document.hidden) void sync.sync();
      };
      const hidden = () => {
        if (document.hidden) {
          clearTimeout(timer);
          void sync.sync();
        }
      };
      const changedStorage = (event: StorageEvent) => {
        if (event.key === libraryCacheKey(userId)) {
          sync.reload();
          void sync.sync();
        }
      };
      const saveBeforeLeave = () => {
        try {
          sync.save();
        } catch {
          /* The device library also flushes before leaving. */
        }
      };
      window.addEventListener('online', retry);
      window.addEventListener('focus', retry);
      document.addEventListener('visibilitychange', hidden);
      window.addEventListener('storage', changedStorage);
      window.addEventListener('pagehide', saveBeforeLeave);
      const poll = setInterval(retry, 60000);
      void sync.sync();
      return () => {
        active = false;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe();
        sync.stop();
        if (controller.current === sync) controller.current = null;
        window.removeEventListener('online', retry);
        window.removeEventListener('focus', retry);
        document.removeEventListener('visibilitychange', hidden);
        window.removeEventListener('storage', changedStorage);
        window.removeEventListener('pagehide', saveBeforeLeave);
      };
    } catch {
      // A storage failure must never import another account's data.
      if (!importLocal)
        current.current.update(() => restoreLibrary(null), 'remote-memory');
      setState({
        pending: 0,
        syncing: false,
        error:
          'Account library storage is unavailable. Please allow site storage and reload.',
      });
    }
  }, [userId, ready, subscribe]);
  return { ...state, refresh };
}
