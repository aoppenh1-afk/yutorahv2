import { BoundedCache } from './bounded-cache';
import { plain } from './yutorah';

export type OfficialChapter = {
  title: string;
  summary: string;
  start: number;
  end: number;
};
export type OfficialStudy = {
  id: number;
  summary: string;
  chapters: OfficialChapter[];
  source: 'YUTorah';
  available: boolean;
};
const cache = new BoundedCache<OfficialStudy>(48, 3 * 1024 * 1024);
const pending = new Map<number, Promise<OfficialStudy>>();

export function normalizeOfficialStudy(
  id: number,
  raw: unknown,
): OfficialStudy {
  const input = raw as Record<string, unknown> | null;
  const chapters = (Array.isArray(input?.Chapters) ? input.Chapters : [])
    .flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const c = value as Record<string, unknown>;
      const start = Number(c.start_seconds),
        end = Number(c.end_seconds);
      const title = plain(c.title ?? c.Title).slice(0, 500);
      return title &&
        Number.isFinite(start) &&
        start >= 0 &&
        start < 86400 &&
        Number.isFinite(end) &&
        end > start &&
        end <= 86400
        ? [
            {
              title,
              summary: plain(c.summary ?? c.Summary).slice(0, 12000),
              start,
              end,
            },
          ]
        : [];
    })
    .slice(0, 500)
    .sort((a, b) => a.start - b.start);
  const summary = plain(input?.Summary).slice(0, 30000);
  return {
    id,
    summary,
    chapters,
    source: 'YUTorah',
    available: !!summary || chapters.length > 0,
  };
}

export async function officialStudy(
  id: number,
  fresh = false,
): Promise<OfficialStudy> {
  if (fresh) cache.delete(String(id));
  const hit = cache.get(String(id));
  if (hit) return hit;
  const running = pending.get(id);
  if (running) return running;
  if (pending.size >= 24)
    throw new Error('Study content is busy. Please retry.');
  const read = (async () => {
    const r = await fetch(
      `https://api.yutorah.org/transcriptions/shiur/${id}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
        redirect: 'manual',
      },
    );
    if (r.status === 404 || r.status === 204) {
      await r.body?.cancel();
      return normalizeOfficialStudy(id, null);
    }
    if (
      !r.ok ||
      !/application\/json/i.test(r.headers.get('content-type') || '')
    ) {
      await r.body?.cancel();
      throw new Error('YUTorah study content could not load.');
    }
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let text = '',
      size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8_000_000) throw new Error('Study content is too large.');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    } finally {
      reader.releaseLock();
    }
    return normalizeOfficialStudy(id, JSON.parse(text));
  })()
    .then((result) => {
      cache.set(String(id), result, result.available ? 600000 : 60000);
      return result;
    })
    .finally(() => pending.delete(id));
  pending.set(id, read);
  return read;
}
