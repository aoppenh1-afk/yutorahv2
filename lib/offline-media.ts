import { AUDIO_CACHE, offlineAudioPath } from './download-contract';
import { portraitSources } from './portrait';

export const PORTRAIT_CACHE = 'yutorah-portraits-v1';

/** Reading existing media must not load or start the transfer manager. */
export async function localRecording(id: number) {
  try {
    return await (await caches.open(AUDIO_CACHE)).match(offlineAudioPath(id));
  } catch {
    return undefined;
  }
}
export async function cachedPortrait(src: string) {
  try {
    const cache = await caches.open(PORTRAIT_CACHE);
    for (const url of portraitSources(src)) {
      const hit = await cache.match(url);
      if (hit) return hit;
    }
  } catch {
    /* Browsing still works without Cache Storage. */
  }
  return undefined;
}
