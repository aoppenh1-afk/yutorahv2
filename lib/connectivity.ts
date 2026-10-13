'use client';
import { useSyncExternalStore } from 'react';

declare global {
  interface Window {
    __YUTORAH_OFFLINE__?: boolean;
  }
}
type Connection = { online: boolean; checking: boolean };
const initial: Connection = { online: true, checking: false };
let state = initial;
const listeners = new Set<() => void>();
let pending: Promise<boolean> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
function publish(update: Partial<Connection>) {
  state = { ...state, ...update };
  listeners.forEach((fn) => fn());
}
export function checkConnection() {
  if (pending) return pending;
  if (!navigator.onLine) {
    publish({ online: false, checking: false });
    return Promise.resolve(false);
  }
  publish({ checking: true });
  pending = (async () => {
    try {
      const response = await fetch('/api/connection', {
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
      });
      // A server error still proves connectivity. Do not confuse it with an offline device.
      await response.body?.cancel();
      if (!navigator.onLine) {
        publish({ online: false });
        return false;
      }
      window.__YUTORAH_OFFLINE__ = false;
      publish({ online: true });
      return true;
    } catch {
      publish({ online: false });
      return false;
    } finally {
      publish({ checking: false });
      pending = undefined;
    }
  })();
  return pending;
}
function offline() {
  publish({ online: false, checking: false });
}
function online() {
  void checkConnection();
}
function visible() {
  if (!document.hidden) void checkConnection();
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (listeners.size === 1) {
    publish({ online: navigator.onLine && !window.__YUTORAH_OFFLINE__ });
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    timer = setInterval(() => {
      if (!state.online && !document.hidden) void checkConnection();
    }, 15000);
    void checkConnection();
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
      clearInterval(timer);
    }
  };
}
export function useConnectivity() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => initial,
  );
}

export function useOnline() {
  return useSyncExternalStore(
    subscribe,
    () => state.online,
    () => true,
  );
}
