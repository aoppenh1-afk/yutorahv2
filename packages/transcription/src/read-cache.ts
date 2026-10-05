import { Buffer } from 'node:buffer';
import type { TranscriptionStore } from './store.js';
import type { PublicContent } from './public-content.js';

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
};

/** Per-process, bounded reads. Expiration never extends when an entry is used. */
class ReadCache<T> {
  private entries = new Map<
    string,
    { value: T; until: number; bytes: number }
  >();
  private pending = new Map<string, Promise<T>>();
  private bytes = 0;
  constructor(private options: CacheOptions) {}

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
  ): Promise<T> {
    const now = this.options.now ?? Date.now;
    const cached = this.entries.get(key);
    if (!fresh && cached && cached.until > now()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached.value);
    }
    this.remove(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    // Bound bookkeeping for concurrent distinct searches as well as stored data.
    if (this.pending.size >= (this.options.maxPending ?? 64)) return load();
    const task = Promise.resolve()
      .then(load)
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
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}

/** Share identical reads, including requests that arrive before the first completes. */
export function createCachedTranscriptReader(
  source: TranscriptReader,
  options: CacheOptions = {},
): TranscriptReader {
  const content = new ReadCache<
    Awaited<ReturnType<TranscriptReader['content']>>
  >(options);
  const search = new ReadCache<Awaited<ReturnType<TranscriptReader['search']>>>(
    options,
  );
  const status = new ReadCache<
    Awaited<ReturnType<TranscriptionStore['contentStatus']>>
  >(options);
  return {
    content: (id, fresh = false) =>
      content.get(id, () => source.content(id), 3_600_000, fresh),
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
