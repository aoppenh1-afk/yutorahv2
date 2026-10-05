/** Small process-local caches supplement durable storage; they are never locks. */
export class BoundedCache<T> {
  private entries = new Map<
    string,
    { value: T; expires: number; bytes: number }
  >();
  private bytes = 0;
  constructor(
    private maxEntries = 128,
    private maxBytes = 8 * 1024 * 1024,
  ) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) {
      this.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(
    key: string,
    value: T,
    ttl: number,
    bytes = new TextEncoder().encode(JSON.stringify(value)).length,
  ) {
    this.delete(key);
    if (bytes > this.maxBytes || ttl <= 0) return;
    this.entries.set(key, { value, expires: Date.now() + ttl, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes)
      this.delete(this.entries.keys().next().value!);
  }
  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
