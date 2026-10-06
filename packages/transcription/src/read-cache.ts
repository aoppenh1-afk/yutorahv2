import { Buffer } from 'node:buffer';
import type { TranscriptionStore } from './store.js';
import type { PublicContent } from './public-content.js';
import { performanceSample } from '../../../lib/performance-metrics.js';

export type TranscriptReader = {
  content: (id: string, fresh?: boolean) => Promise<PublicContent | null>;
  search: TranscriptionStore['search'];
  contentStatus?: TranscriptionStore['contentStatus'];
};
type CacheOptions = {
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  maxPending?: number;
  maxQueued?: number;
  queueTimeoutMs?: number;
};
type CachedTranscriptReader = Omit<TranscriptReader, 'content'> & {
  content: (
    id: string,
    fresh?: boolean,
    signal?: AbortSignal,
  ) => Promise<PublicContent | null>;
};

export class TranscriptOverloadedError extends Error {
  constructor() {
    super('Transcript reads are busy. Retry shortly.');
  }
}

/** One admission bound across content, status and search, including pool waits. */
class ReadAdmission {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private options: CacheOptions) {}
  async run<T>(load: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= (this.options.maxPending ?? 64)) {
      if (this.queue.length >= (this.options.maxQueued ?? 64))
        throw new TranscriptOverloadedError();
      await new Promise<void>((resolve, reject) => {
        const remove = () => {
          const index = this.queue.indexOf(start);
          if (index >= 0) this.queue.splice(index, 1);
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
        };
        const start = () => {
          remove();
          this.active++;
          resolve();
        };
        const cancel = () => {
          remove();
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          remove();
          reject(new TranscriptOverloadedError());
        }, this.options.queueTimeoutMs ?? 8000);
        signal.addEventListener('abort', cancel, { once: true });
        this.queue.push(start);
      });
    } else this.active++;
    try {
      signal.throwIfAborted();
      return await load();
    } finally {
      this.active--;
      this.queue[0]?.();
    }
  }
}

/** Per-process, bounded reads. Expiration never extends when an entry is used. */
class ReadCache<T> {
  private entries = new Map<
    string,
    { value: T; until: number; bytes: number }
  >();
  private pending = new Map<
    string,
    { task: Promise<T>; controller: AbortController; users: number }
  >();
  private bytes = 0;
  constructor(
    private options: CacheOptions,
    private admission: ReadAdmission,
  ) {}

  private subscribe(
    pending: { task: Promise<T>; controller: AbortController; users: number },
    signal?: AbortSignal,
  ): Promise<T> {
    pending.users++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener('abort', cancel);
        if (--pending.users === 0) pending.controller.abort();
        return true;
      };
      const cancel = () => {
        if (finish()) reject(signal!.reason);
      };
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      pending.task.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  get(
    key: string,
    load: () => Promise<T>,
    ttl: number,
    fresh = false,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const now = this.options.now ?? Date.now;
    const cached = this.entries.get(key);
    if (!fresh && cached && cached.until > now()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      performanceSample('transcript_read_cache', { hit: 1 });
      return Promise.resolve(cached.value);
    }
    this.remove(key);
    const existing = this.pending.get(key);
    if (existing && !existing.controller.signal.aborted) {
      performanceSample('transcript_read_cache', { coalesced: 1 });
      return this.subscribe(existing, signal);
    }
    performanceSample('transcript_read_cache', { hit: 0 });
    const controller = new AbortController();
    const pending = {
      task: undefined as unknown as Promise<T>,
      controller,
      users: 0,
    };
    const task = Promise.resolve()
      .then(() => this.admission.run(load, controller.signal))
      .then((value) => {
        // Missing transcripts may be published at any moment. Never retain them.
        if (value === null) return value;
        const bytes =
          Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key);
        const maxBytes = this.options.maxBytes ?? 8 * 1024 * 1024;
        if (bytes > Math.min(maxBytes, 2 * 1024 * 1024)) return value;
        for (const [id, entry] of this.entries)
          if (entry.until <= now()) this.remove(id);
        while (
          this.entries.size >= (this.options.maxEntries ?? 128) ||
          this.bytes + bytes > maxBytes
        ) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) return value;
          this.remove(oldest);
        }
        this.entries.set(key, { value, until: now() + ttl, bytes });
        this.bytes += bytes;
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      });
    pending.task = task;
    this.pending.set(key, pending);
    return this.subscribe(pending, signal);
  }
}

/** Share identical reads, including requests that arrive before the first completes. */
export function createCachedTranscriptReader(
  source: TranscriptReader,
  options: CacheOptions = {},
): CachedTranscriptReader {
  for (const limit of [options.maxPending ?? 64, options.maxQueued ?? 64])
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('Invalid transcript read limit.');
  const admission = new ReadAdmission(options);
  const content = new ReadCache<
    Awaited<ReturnType<TranscriptReader['content']>>
  >(options, admission);
  const search = new ReadCache<Awaited<ReturnType<TranscriptReader['search']>>>(
    options,
    admission,
  );
  const status = new ReadCache<
    Awaited<ReturnType<TranscriptionStore['contentStatus']>>
  >(options, admission);
  return {
    content: (id, fresh = false, signal) =>
      content.get(id, () => source.content(id), 3_600_000, fresh, signal),
    contentStatus: source.contentStatus
      ? (id) => status.get(id, () => source.contentStatus!(id), 15_000)
      : undefined,
    search: (query, aliases, limit, mode) =>
      search.get(
        JSON.stringify([query, aliases, limit, mode]),
        () => source.search(query, aliases, limit, mode),
        15_000,
      ),
  };
}
