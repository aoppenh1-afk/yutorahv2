'use client';
import type { Shiur } from './yutorah';
import { AUDIO_CACHE, offlineAudioPath } from './download-contract';
import { portraitSources } from './portrait';
import { cachedPortrait, PORTRAIT_CACHE } from './offline-media';
export { cachedPortrait, PORTRAIT_CACHE } from './offline-media';

export const STUDY_CACHE = 'yutorah-study-v1';
const endpoints = ['transcript', 'study-notes', 'official-study'] as const;
type Endpoint = (typeof endpoints)[number];
export type OfflineContentStatus = {
  transcript: boolean;
  notes: boolean;
  summary: boolean;
  image: boolean;
  checkedAt: number;
};
const studyPath = (kind: Endpoint, id: number) => `/api/${kind}?id=${id}`;
const offline = () => !navigator.onLine || Boolean(window.__YUTORAH_OFFLINE__);
function shiurPortraits(shiur: Shiur) {
  const unique = new Map<string, string>();
  for (const src of [
    shiur.image,
    ...(shiur.speakers?.map((speaker) => speaker.image) || []),
  ]) {
    const key = portraitSources(src)[0];
    if (key) unique.set(key, src);
  }
  return [...unique.values()];
}

/** Read the entire body before committing, with a limit independent of Content-Length. */
async function boundedBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty offline content.');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('Offline content is too large.');
      chunks.push(new Uint8Array(chunk.value));
    }
    return new Blob(chunks, {
      type: response.headers.get('content-type') || '',
    });
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function usable(kind: Endpoint, data: Record<string, unknown>) {
  if (kind === 'transcript')
    return (
      Array.isArray(data.segments) &&
      data.segments.some((s) => typeof s?.text === 'string' && s.text.trim())
    );
  if (kind === 'study-notes')
    return (
      data.status === 'completed' &&
      typeof data.markdown === 'string' &&
      Boolean(data.markdown.trim())
    );
  return (
    data.available === true &&
    ((typeof data.summary === 'string' && Boolean(data.summary.trim())) ||
      (Array.isArray(data.chapters) && data.chapters.length > 0))
  );
}

async function saveStudy(
  kind: Endpoint,
  id: number,
  response: Response,
  signal?: AbortSignal,
) {
  if (
    !response.ok ||
    !response.headers.get('content-type')?.includes('application/json')
  )
    return false;
  const blob = await boundedBody(response.clone(), 8 * 1024 * 1024);
  const data = JSON.parse(await blob.text());
  if (!data || !usable(kind, data)) return false;
  signal?.throwIfAborted();
  await (
    await caches.open(STUDY_CACHE)
  )
    .put(
      studyPath(kind, id),
      new Response(blob, {
        headers: {
          'Content-Type': 'application/json',
          'X-YUTorah-Created': String(Date.now()),
        },
      }),
    )
    .catch(() => {});
  return true;
}

/** Public study routes only. Account data is never persisted here. */
export async function fetchStudy(url: string, options: RequestInit = {}) {
  if (!('caches' in window)) return fetch(url, options);
  const parsed = new URL(url, location.origin);
  const kind = endpoints.find((value) => parsed.pathname === `/api/${value}`);
  const id = Number(parsed.searchParams.get('id'));
  if (
    parsed.origin !== location.origin ||
    !kind ||
    !Number.isSafeInteger(id) ||
    id <= 0
  )
    throw new Error('Invalid study content request.');
  const cache = await caches.open(STUDY_CACHE).catch(() => undefined);
  const cached = await cache?.match(studyPath(kind, id)).catch(() => undefined);
  options.signal?.throwIfAborted();
  if (offline())
    return (
      cached ||
      Response.json(
        {
          error:
            'This content was not saved for offline use. Connect to the internet to load it.',
        },
        { status: 404 },
      )
    );
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(12_000)])
    : AbortSignal.timeout(12_000);
  try {
    const response = await fetch(url, {
      ...options,
      signal,
      credentials: 'omit',
    });
    options.signal?.throwIfAborted();
    // Saving is opt-in through the audio download, not general browsing.
    const downloaded = await caches
      .open(AUDIO_CACHE)
      .then((audio) => audio.match(offlineAudioPath(id)))
      .catch(() => undefined);
    if (downloaded && response.ok) {
      const saved = await saveStudy(
        kind,
        id,
        response,
        options.signal ?? undefined,
      ).catch(() => false);
      if (!saved && cached) return cached;
    }
    if (!response.ok && cached) return cached;
    return response;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (cached) return cached;
    throw error;
  }
}

async function savePortrait(src: string, signal: AbortSignal) {
  if (await cachedPortrait(src)) return;
  const sources = portraitSources(src);
  for (const url of sources) {
    signal.throwIfAborted();
    try {
      // Readable CORS responses avoid the large quota charge for opaque images.
      // The CDN receives the request directly, without a website-hosting relay.
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit',
        signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      });
      if (
        !response.ok ||
        !/^image\/(jpeg|png|webp|gif|avif)(?:;|$)/i.test(
          response.headers.get('content-type') || '',
        )
      ) {
        await response.body?.cancel();
        continue;
      }
      const blob = await boundedBody(response, 512 * 1024);
      if (!blob.size) continue;
      signal.throwIfAborted();
      await (
        await caches.open(PORTRAIT_CACHE)
      ).put(
        sources[0],
        new Response(blob, {
          headers: {
            'Content-Type': blob.type,
            'X-YUTorah-Created': String(Date.now()),
          },
        }),
      );
      return;
    } catch {
      signal.throwIfAborted();
    }
  }
}

/** Optional content must never invalidate a successfully saved recording. */
export async function saveOfflineContent(
  shiur: Shiur,
  signal: AbortSignal,
): Promise<OfflineContentStatus> {
  await Promise.allSettled([
    (async () => {
      for (const src of shiurPortraits(shiur)) await savePortrait(src, signal);
    })(),
    ...endpoints.map((kind) =>
      fetchStudy(studyPath(kind, shiur.id), { signal }),
    ),
  ]);
  signal.throwIfAborted();
  const cache = await caches.open(STUDY_CACHE);
  const [transcript, notes, summary, image] = await Promise.all([
    ...endpoints.map((kind) => cache.match(studyPath(kind, shiur.id))),
    cachedPortrait(shiur.image),
  ]);
  return {
    transcript: Boolean(transcript),
    notes: Boolean(notes),
    summary: Boolean(summary),
    image: Boolean(image),
    checkedAt: Date.now(),
  };
}

export async function removeOfflineContent(id: number, remaining: Shiur[]) {
  const cache = await caches.open(STUDY_CACHE);
  await Promise.all(endpoints.map((kind) => cache.delete(studyPath(kind, id))));
  // A rebbe's image is shared by all their downloads. Keep it until the last one is removed.
  const portraits = await caches.open(PORTRAIT_CACHE);
  const used = new Set(
    remaining.flatMap((shiur) =>
      shiurPortraits(shiur).flatMap(portraitSources),
    ),
  );
  for (const key of await portraits.keys())
    if (!used.has(key.url)) {
      const response = await portraits.match(key);
      // Protect an image being committed by a download in another tab.
      if (
        Date.now() - Number(response?.headers.get('X-YUTorah-Created') || 0) >
        15 * 60_000
      )
        await portraits.delete(key);
    }
}

export async function pruneOfflineContent(shiurim: Shiur[]) {
  const used = new Set(shiurim.map((shiur) => shiur.id));
  const cache = await caches.open(STUDY_CACHE);
  for (const key of await cache.keys()) {
    const id = Number(new URL(key.url).searchParams.get('id'));
    const response = await cache.match(key);
    if (
      !used.has(id) &&
      Date.now() - Number(response?.headers.get('X-YUTorah-Created') || 0) >
        15 * 60_000
    )
      await cache.delete(key);
  }
  // Also reclaim unused portraits, retaining recent cross-tab writes.
  await removeOfflineContent(0, shiurim);
}
