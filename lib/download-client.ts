import { useSyncExternalStore } from 'react';
import type { Shiur } from './yutorah';

type Manager = typeof import('./downloads');
type Snapshot = ReturnType<Manager['useDownloads']>;
const initial: Snapshot = {
  items: [],
  jobs: [],
  ready: false,
  error: '',
  offlineReady: false,
};
let snapshot = initial;
let manager: Manager | undefined;
let pending: Promise<Manager> | undefined;
function loadManager() {
  pending ??= import('./downloads')
    .then((value) => {
      manager = value;
      return value;
    })
    .catch((error) => {
      pending = undefined;
      throw new Error(
        'Downloads could not load. Reload the page and try again.',
        { cause: error },
      );
    });
  return pending;
}
function subscribe(notify: () => void) {
  let stopped = false;
  let cleanup: (() => void) | undefined;
  void loadManager()
    .then((value) => {
      if (!stopped)
        cleanup = value.watchDownloads((value) => {
          snapshot = value;
          notify();
        });
    })
    .catch(() => {
      /* Status failures must not interrupt navigation. */
    });
  return () => {
    stopped = true;
    cleanup?.();
  };
}
export function useDownloadCount() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.items.length,
    () => 0,
  );
}
export function useDownloads() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => initial,
  );
}
export async function downloadShiur(shiur: Shiur) {
  return (await loadManager()).downloadShiur(shiur);
}
export function cancelDownload(id: number) {
  manager?.cancelDownload(id);
}
