'use client';
let registration: Promise<ServiceWorkerRegistration> | undefined;
let preparation: Promise<void> | undefined;

export function registerOfflineWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator))
    return Promise.reject(
      new Error('This browser cannot save the app for offline use.'),
    );
  registration ??= navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then(async (reg) => {
      // Existing users may still have the old push-only worker. `ready` alone
      // resolves to that worker before this release finishes installing.
      const installing = reg.installing || reg.waiting;
      if (installing && installing.state !== 'activated') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              finish(
                new Error(
                  'Could not update the app for offline use. Try again.',
                ),
              ),
            60_000,
          );
          const changed = () => {
            if (installing.state === 'activated') finish();
            else if (installing.state === 'redundant')
              finish(
                new Error(
                  'Could not save the app for offline use. Check your connection and try again.',
                ),
              );
          };
          const finish = (error?: Error) => {
            clearTimeout(timer);
            installing.removeEventListener('statechange', changed);
            if (error) reject(error);
            else resolve();
          };
          installing.addEventListener('statechange', changed);
          changed();
        });
      }
      if (reg.active) return reg;
      throw new Error('The app is not ready for offline use. Try again.');
    })
    .catch((error) => {
      registration = undefined;
      throw error;
    });
  return registration;
}
/** Do not label audio available offline until the app shell is also cached. */
export function ensureOfflineReady() {
  preparation ??= (async () => {
    const reg = await registerOfflineWorker();
    const worker = reg.active;
    if (!worker)
      throw new Error('The app is not ready for offline use. Try again.');
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(
          new Error(
            'Could not prepare the app for offline use. Check your connection and try again.',
          ),
        );
      }, 60_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        if (event.data?.ready) resolve();
        else
          reject(
            new Error(
              event.data?.error ||
                'Could not prepare the app for offline use. Try again.',
            ),
          );
      };
      worker.postMessage({ type: 'PREPARE_OFFLINE' }, [channel.port2]);
    });
  })().catch((error) => {
    preparation = undefined;
    throw error;
  });
  return preparation;
}
