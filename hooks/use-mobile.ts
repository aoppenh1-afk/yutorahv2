import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;

const subscribers = new Set<() => void>();
let query: MediaQueryList | undefined;
const changed = () => subscribers.forEach((notify) => notify());
function subscribe(notify: () => void) {
  query ??= window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  if (!subscribers.size) query.addEventListener('change', changed);
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (!subscribers.size) query?.removeEventListener('change', changed);
  };
}
export function useIsMobile() {
  return useSyncExternalStore(
    subscribe,
    () =>
      query?.matches ??
      window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches,
    () => false,
  );
}
