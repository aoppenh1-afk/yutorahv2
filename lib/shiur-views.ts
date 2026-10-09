import { BoundedCache } from './bounded-cache';
import { readTrendingResponse } from './trending-source';
import { viewCount } from './view-count';

/** Homepage and detail metadata omit counters. Numeric search returns them. */
export function createShiurViewsReader() {
  const cache = new BoundedCache<number | null>(1024, 64 * 1024);
  const pending = new Map<number, Promise<number | undefined>>();
  let active = 0;
  const waiting: (() => void)[] = [];

  async function read(id: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(id) || id <= 0 || id > 999999999) return;
    const hit = cache.get(String(id));
    if (hit !== undefined) return hit ?? undefined;
    const existing = pending.get(id);
    if (existing) return existing;
    const request = (async () => {
      // Limit upstream concurrency across batches and detail requests.
      if (active >= 6)
        await new Promise<void>((resolve) => waiting.push(resolve));
      else active++;
      try {
        const query = new URLSearchParams({
          searchTerm: String(id),
          start: '1',
        });
        const response = await fetch(
          `https://api.yutorah.org/search/get?${query}`,
          {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
          },
        );
        const result = await readTrendingResponse(response);
        // Never use the first result blindly: upstream can ignore filters.
        const raw = result.response.docs.find(
          (s) => Number(s.shiurid ?? s.shiurID) === id,
        );
        const count = viewCount(raw?.shiurvisitsnum);
        cache.set(
          String(id),
          count ?? null,
          count === undefined ? 60000 : 300000,
        );
        return count;
      } catch {
        // A counter outage must not prevent opening or playing a shiur.
        return undefined;
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    })();
    pending.set(id, request);
    try {
      return await request;
    } finally {
      pending.delete(id);
    }
  }

  return async (ids: number[]): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const count = await read(id);
        if (count !== undefined) result[id] = count;
      }),
    );
    return result;
  };
}

export const getShiurViews = createShiurViewsReader();
