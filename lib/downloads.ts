'use client';
import { useSyncExternalStore } from 'react';
import type { Shiur } from './yutorah';
import { mediaKind } from './yutorah';
import {
  AUDIO_CACHE,
  DOWNLOAD_DB,
  MAX_DOWNLOAD_BYTES,
  audioDownloadPath,
  offlineAudioPath,
} from './download-contract';
import { ensureOfflineReady } from './offline-client';
import {
  saveOfflineContent,
  removeOfflineContent,
  pruneOfflineContent,
  type OfflineContentStatus,
} from './offline-content';

export type DownloadedShiur = {
  id: number;
  shiur: Shiur;
  bytes: number;
  downloadedAt: string;
  content?: OfflineContentStatus;
};
export type DownloadJob = {
  shiur: Shiur;
  status: 'queued' | 'downloading' | 'failed';
  bytes: number;
  total: number;
  error?: string;
  savingContent?: boolean;
};
type Snapshot = {
  items: DownloadedShiur[];
  jobs: DownloadJob[];
  ready: boolean;
  error: string;
  offlineReady: boolean;
};
const initial: Snapshot = {
  items: [],
  jobs: [],
  ready: false,
  error: '',
  offlineReady: false,
};
let snapshot = initial;
const listeners = new Set<() => void>();
const jobs = new Map<number, DownloadJob>();
const controllers = new Map<number, AbortController>();
const contentControllers = new Map<number, AbortController>();
let loading: Promise<void> | undefined;
let enriching: Promise<void> | undefined;
let active = false;
let channel: BroadcastChannel | undefined;
let contentRefreshTimer: ReturnType<typeof setInterval> | undefined;
let database: Promise<IDBDatabase> | undefined;
function publish(update: Partial<Snapshot> = {}) {
  snapshot = { ...snapshot, ...update, jobs: [...jobs.values()] };
  listeners.forEach((fn) => fn());
}
function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DOWNLOAD_DB, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('shiurim', { keyPath: 'id' });
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () =>
      reject(new Error('Close other YUTorah tabs and try again.'));
  });
  return database;
}
async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('shiurim', mode);
    const request = operation(transaction.objectStore('shiurim'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error || request.error);
    transaction.onabort = () =>
      reject(transaction.error || new Error('Could not save this download.'));
  });
}
async function refresh() {
  if (
    !('caches' in window) ||
    !('indexedDB' in window) ||
    !window.isSecureContext
  )
    throw new Error(
      'Offline downloads need a supported browser and a secure connection.',
    );
  const [items, cache] = await Promise.all([
    transact<DownloadedShiur[]>('readonly', (store) => store.getAll()),
    caches.open(AUDIO_CACHE),
  ]);
  const available: DownloadedShiur[] = [];
  const validKeys = new Set<string>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.id) || !item.shiur?.title || item.bytes <= 0)
      continue;
    const path = offlineAudioPath(item.id);
    const response = await cache.match(path);
    if (response?.headers.get('X-YUTorah-Complete') === String(item.bytes)) {
      available.push(item);
      validKeys.add(new URL(path, location.origin).href);
    } else await transact('readwrite', (store) => store.delete(item.id));
  }
  // An interrupted write can leave bytes without a metadata record. Drop those on startup.
  for (const key of await cache.keys())
    if (
      !validKeys.has(key.url) &&
      !controllers.has(Number(new URL(key.url).pathname.split('/').pop()))
    ) {
      const response = await cache.match(key);
      const created = Number(response?.headers.get('X-YUTorah-Created')) || 0;
      if (Date.now() - created > 15 * 60_000) await cache.delete(key);
    }
  publish({
    items: available.sort((a, b) =>
      b.downloadedAt.localeCompare(a.downloadedAt),
    ),
    ready: true,
    error: '',
  });
  await pruneOfflineContent([
    ...available.map((item) => item.shiur),
    ...[...jobs.values()].map((job) => job.shiur),
  ]).catch(() => {});
  // Keep downloaded materials current, including revisions to already saved
  // content. Check at most hourly while online; audio remains playable.
  if (navigator.onLine && !window.__YUTORAH_OFFLINE__ && !enriching)
    enriching = (async () => {
      for (const item of available)
        if (!item.content || Date.now() - item.content.checkedAt > 60 * 60_000)
          await updateDownloadContent(item.id).catch(() => {});
    })().finally(() => {
      enriching = undefined;
    });
}
export function loadDownloads() {
  loading ??= refresh()
    .catch((error) => publish({ ready: true, error: message(error) }))
    .finally(() => {
      loading = undefined;
    });
  return loading;
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (listeners.size === 1) {
    void loadDownloads();
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(DOWNLOAD_DB);
      channel.onmessage = () => {
        void loadDownloads();
      };
    }
    window.addEventListener('pageshow', onVisible);
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    contentRefreshTimer = setInterval(onVisible, 60 * 60_000);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      channel?.close();
      channel = undefined;
      window.removeEventListener('pageshow', onVisible);
      window.removeEventListener('online', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(contentRefreshTimer);
      contentRefreshTimer = undefined;
    }
  };
}
function onVisible() {
  if (!document.hidden && !active) void loadDownloads();
}
export function useDownloads() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => initial,
  );
}
function message(error: unknown) {
  if (error instanceof TypeError)
    return 'The download was interrupted. Check your internet connection and try again.';
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return 'Not enough storage. Remove a download or free space on your device, then try again.';
  return error instanceof Error
    ? error.message
    : 'Could not download this shiur. Try again.';
}
export async function downloadShiur(shiur: Shiur) {
  if (jobs.has(shiur.id) && jobs.get(shiur.id)?.status !== 'failed') return;
  if (snapshot.items.some((item) => item.id === shiur.id)) return;
  if (mediaKind(shiur) !== 'audio')
    throw new Error(
      'Only audio shiurim can be downloaded for offline listening.',
    );
  if (!navigator.onLine)
    throw new Error('Connect to the internet to download this shiur.');
  jobs.set(shiur.id, { shiur, status: 'queued', bytes: 0, total: 0 });
  publish();
  void pump();
}
export function cancelDownload(id: number) {
  controllers.get(id)?.abort();
  jobs.delete(id);
  publish();
}
async function pump() {
  if (active) return;
  const job = [...jobs.values()].find((value) => value.status === 'queued');
  if (!job) return;
  active = true;
  const id = job.shiur.id;
  const controller = new AbortController();
  controllers.set(id, controller);
  const path = offlineAudioPath(id);
  let written = false;
  try {
    await ensureOfflineReady();
    publish({ offlineReady: true });
    controller.signal.throwIfAborted();
    job.status = 'downloading';
    publish();
    const response = await fetch(audioDownloadPath(id), {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      const reply = await response.json().catch(() => null);
      throw new Error(
        reply?.error || 'The recording could not be downloaded. Try again.',
      );
    }
    if (
      !response.body ||
      !response.headers.get('content-type')?.startsWith('audio/')
    )
      throw new Error('The source did not return an audio recording.');
    job.total = Number(response.headers.get('content-length')) || 0;
    if (job.total > MAX_DOWNLOAD_BYTES)
      throw new Error('This recording is too large to download in the app.');
    const storage = await navigator.storage?.estimate?.();
    if (
      job.total &&
      storage?.quota &&
      job.total > storage.quota - (storage.usage || 0)
    )
      throw new DOMException('Storage is full.', 'QuotaExceededError');
    void navigator.storage?.persist?.().catch(() => false);
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let lastUpdate = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        controller.signal.throwIfAborted();
        if (chunk.done) break;
        job.bytes += chunk.value.byteLength;
        if (job.bytes > MAX_DOWNLOAD_BYTES)
          throw new Error(
            'This recording is too large to download in the app.',
          );
        chunks.push(new Uint8Array(chunk.value));
        if (Date.now() - lastUpdate > 150) {
          publish();
          lastUpdate = Date.now();
        }
      }
      if (!job.bytes || (job.total && job.bytes !== job.total))
        throw new Error('The download was interrupted. Try again.');
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    controller.signal.throwIfAborted();
    const blob = new Blob(chunks, {
      type: response.headers.get('content-type')!,
    });
    const cache = await caches.open(AUDIO_CACHE);
    await cache.put(
      path,
      new Response(blob, {
        headers: {
          'Content-Type': blob.type,
          'Content-Length': String(blob.size),
          'X-YUTorah-Complete': String(blob.size),
          'X-YUTorah-Created': String(Date.now()),
        },
      }),
    );
    written = true;
    controller.signal.throwIfAborted();
    job.savingContent = true;
    publish();
    const content = await saveOfflineContent(
      job.shiur,
      controller.signal,
    ).catch(() => {
      controller.signal.throwIfAborted();
      // A quota failure in optional content leaves the recording available.
      return undefined;
    });
    controller.signal.throwIfAborted();
    const item: DownloadedShiur = {
      id,
      shiur: job.shiur,
      bytes: blob.size,
      downloadedAt: new Date().toISOString(),
      content,
    };
    await transact('readwrite', (store) => store.put(item));
    if (controller.signal.aborted) {
      await transact('readwrite', (store) => store.delete(id));
      controller.signal.throwIfAborted();
    }
    jobs.delete(id);
    publish({
      items: [item, ...snapshot.items.filter((value) => value.id !== id)],
      error: '',
    });
    channel?.postMessage({ id });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    // Stop transfers rejected before a reader was opened, including quota failures.
    controller.abort();
    if (written)
      await (await caches.open(AUDIO_CACHE)).delete(path).catch(() => false);
    if (written)
      await removeOfflineContent(
        id,
        (
          await transact<DownloadedShiur[]>('readonly', (store) =>
            store.getAll(),
          )
        ).map((item) => item.shiur),
      ).catch(() => {});
    if (!cancelled) {
      job.status = 'failed';
      job.error = message(error);
      jobs.set(id, job);
    }
    publish();
  } finally {
    controllers.delete(id);
    active = false;
    void pump();
  }
}
export async function removeDownload(id: number) {
  cancelDownload(id);
  contentControllers.get(id)?.abort();
  await (await caches.open(AUDIO_CACHE)).delete(offlineAudioPath(id));
  await transact('readwrite', (store) => store.delete(id));
  const remaining = await transact<DownloadedShiur[]>('readonly', (store) =>
    store.getAll(),
  );
  await removeOfflineContent(
    id,
    remaining.map((item) => item.shiur),
  );
  publish({ items: snapshot.items.filter((item) => item.id !== id) });
  channel?.postMessage({ id });
}
async function updateDownloadContent(id: number) {
  if (
    contentControllers.has(id) ||
    !navigator.onLine ||
    window.__YUTORAH_OFFLINE__
  )
    return;
  const item = await transact<DownloadedShiur | undefined>(
    'readonly',
    (store) => store.get(id),
  );
  if (!item || contentControllers.has(id)) return;
  const controller = new AbortController();
  contentControllers.set(id, controller);
  try {
    const content = await saveOfflineContent(item.shiur, controller.signal);
    controller.signal.throwIfAborted();
    // Read and write in one transaction so a concurrent removal cannot resurrect a download.
    const updated = await transact<DownloadedShiur | undefined>(
      'readwrite',
      (store) => {
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result && !controller.signal.aborted) {
            request.result.content = content;
            store.put(request.result);
          }
        };
        return request;
      },
    );
    if (updated && !controller.signal.aborted) {
      publish({
        items: snapshot.items.map((value) =>
          value.id === id ? updated : value,
        ),
      });
      channel?.postMessage({ id });
    }
  } finally {
    if (controller.signal.aborted)
      await removeOfflineContent(
        id,
        (
          await transact<DownloadedShiur[]>('readonly', (store) =>
            store.getAll(),
          )
        ).map((value) => value.shiur),
      ).catch(() => {});
    contentControllers.delete(id);
  }
}
export async function localRecording(id: number) {
  try {
    return await (await caches.open(AUDIO_CACHE)).match(offlineAudioPath(id));
  } catch {
    return undefined;
  }
}

export function useDownloadCount() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.items.length,
    () => 0,
  );
}
