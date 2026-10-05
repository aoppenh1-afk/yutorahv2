/** Schedule the next read after completion, and stop timers in hidden tabs. */
export function createStatusPoller({
  read,
  isVisible,
  intervalMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer;
  let pending;
  const cancel = () => {
    clearTimer(timer);
    timer = undefined;
  };
  const refresh = () => {
    if (pending) return pending;
    cancel();
    pending = Promise.resolve()
      .then(read)
      .finally(() => {
        pending = undefined;
        if (isVisible())
          timer = setTimer(() => void refresh().catch(() => {}), intervalMs());
      });
    return pending;
  };
  return {
    refresh,
    visibilityChanged() {
      cancel();
      if (isVisible()) void refresh().catch(() => {});
    },
  };
}

export function statusPollInterval(state, failures) {
  if (failures)
    return Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
  return ['running', 'starting', 'authenticating'].includes(state)
    ? 30_000
    : 120_000;
}
