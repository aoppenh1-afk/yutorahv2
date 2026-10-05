import type { Pool } from 'pg';

/** Wake local workers after durable writes; periodic reconciliation covers other hosts. */
export class WorkWake {
  revision = 0;
  private listeners = new Set<() => void>();
  notify() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  wait(ms: number, signal: AbortSignal, observed = this.revision) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        signal.removeEventListener('abort', abort);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', abort, { once: true });
      this.listeners.add(done);
      if (signal.aborted) abort();
      else if (this.revision !== observed) done();
    });
  }
}
const wakes = new WeakMap<Pool, Map<string, WorkWake>>();
export function workWake(pool: Pool, channel = 'work') {
  let channels = wakes.get(pool);
  if (!channels) {
    channels = new Map();
    wakes.set(pool, channels);
  }
  let wake = channels.get(channel);
  if (!wake) {
    wake = new WorkWake();
    channels.set(channel, wake);
  }
  return wake;
}
