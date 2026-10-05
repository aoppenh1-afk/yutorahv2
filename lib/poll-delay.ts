/** Pause background polling while hidden, with complete abort/listener cleanup. */
export function pollDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden)
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    document.addEventListener('visibilitychange', schedule);
    schedule();
  });
}
