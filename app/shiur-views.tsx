'use client';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Eye } from 'lucide-react';
import type { Shiur } from '@/lib/yutorah';
import { viewCount, viewCountLabel } from '@/lib/view-count';

const counts = new Map<
  number,
  { count: number | undefined; expires: number }
>();
const listeners = new Map<number, Set<() => void>>();
const queued = new Set<number>();
let scheduled = false;
let fetching = false;

function cached(id: number) {
  const hit = counts.get(id);
  return hit && hit.expires > Date.now() ? hit : undefined;
}

function schedule() {
  if (scheduled || fetching) return;
  scheduled = true;
  setTimeout(() => void flush(), 25);
}

async function flush() {
  scheduled = false;
  const ids = [...queued]
    .filter((id) => listeners.has(id) && !cached(id))
    .slice(0, 24);
  for (const id of queued) {
    if (ids.includes(id) || !listeners.has(id) || cached(id)) queued.delete(id);
  }
  if (!ids.length) return;
  fetching = true;
  let views: Record<string, unknown> = {};
  try {
    const response = await fetch('/api/shiur-views?ids=' + ids.join(','), {
      signal: AbortSignal.timeout(35000),
    });
    if (response.ok) views = (await response.json()).views ?? {};
  } catch {
    // Keep unknown counters hidden and allow a later visit to retry.
  } finally {
    for (const id of ids) {
      const count = viewCount(views[id]);
      counts.delete(id);
      counts.set(id, {
        count,
        expires: Date.now() + (count === undefined ? 60000 : 300000),
      });
      for (const notify of listeners.get(id) ?? []) notify();
    }
    while (counts.size > 1024) counts.delete(counts.keys().next().value!);
    fetching = false;
    if (queued.size) schedule();
  }
}

/** All visible shiur displays share one queue, cache, and request per ID. */
export function ShiurViews({ shiur }: { shiur: Pick<Shiur, 'id' | 'views'> }) {
  const { id } = shiur;
  const known = viewCount(shiur.views);
  const ref = useRef<HTMLSpanElement>(null);
  const resolved = useSyncExternalStore(
    (notify) => {
      const subscribers = listeners.get(id) ?? new Set();
      subscribers.add(notify);
      listeners.set(id, subscribers);
      return () => {
        subscribers.delete(notify);
        if (!subscribers.size) listeners.delete(id);
      };
    },
    () => cached(id)?.count,
    () => undefined,
  );
  const count = known ?? resolved;
  useEffect(() => {
    if (
      known !== undefined ||
      cached(id) ||
      !Number.isSafeInteger(id) ||
      id <= 0
    )
      return;
    const target = ref.current?.parentElement;
    if (!target) return;
    const load = () => {
      queued.add(id);
      schedule();
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: '100px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [id, known, resolved]);
  return (
    <span
      ref={ref}
      className="shiur-views"
      title={count === undefined ? undefined : 'Total views on YUTorah'}
    >
      {count !== undefined && (
        <>
          <Eye size={13} aria-hidden="true" />
          {viewCountLabel(count)}
        </>
      )}
    </span>
  );
}
