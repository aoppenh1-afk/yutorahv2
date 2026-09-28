import { abortReason, checkAbort } from './errors.js';

/** FIFO, shared by every ACP call in the owning worker. Waiting consumes no deadline. */
export class SessionPool {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(readonly limit = 3) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error('Invalid session limit');
  }
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    checkAbort(signal);
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        this.waiters = this.waiters.filter((w) => w !== enter);
        reject(abortReason(signal));
      };
      const enter = () => {
        signal.removeEventListener('abort', cancel);
        this.active++;
        resolve();
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.waiters.push(enter);
      this.drain();
    });
    try {
      checkAbort(signal);
      return await operation();
    } finally {
      this.active--;
      this.drain();
    }
  }
  private drain() {
    while (this.active < this.limit && this.waiters.length)
      this.waiters.shift()!();
  }
}
