import type { RawShiur } from './api-types';
import {
  normalize,
  upstream,
  plain,
  safeUrl,
  getDirectory,
  enrichShiur,
} from './yutorah';
import { catalogVenues, shiurCollections } from './catalog';
import { getShiurViews } from './shiur-views';

/** The playable recording and supplied materials need only one upstream read. */
export async function shiurCore(id: number) {
  const raw = await upstream<RawShiur>('shiur/details?shiurID=' + id, 600);
  if (!raw?.shiurID) return null;
  const shiur = normalize(raw);
  return {
    ...shiur,
    text: plain(raw.shiurText),
    video: safeUrl(
      (raw.shiurDescription || '').match(
        /https?:\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/watch\?v=)[a-zA-Z0-9_-]+/,
      )?.[0] ||
        raw.shiurPlayerURL ||
        (shiur.format === 'mp4' ? shiur.audio : ''),
    ),
    materials: (raw.shiurMaterials || [])
      .map((m) => ({
        name: plain(m.name || m.title || m.materialName),
        url: safeUrl(m.url || m.fileURL || m.materialURL),
      }))
      .filter((m) => m.url),
  };
}
export async function shiurEnrichment(id: number) {
  const [core, directory, collections] = await Promise.all([
    shiurCore(id),
    getDirectory().catch(() => null),
    shiurCollections([id]).catch(() => null),
  ]);
  if (!core) return null;
  const shiur = directory ? { ...core, ...enrichShiur(core, directory) } : core;
  const [venues, views] = await Promise.all([
    shiur.venueId && !shiur.venue
      ? catalogVenues().catch(() => [])
      : Promise.resolve([]),
    shiur.views === undefined
      ? getShiurViews([id])
      : Promise.resolve({} as Record<string, number>),
  ]);
  if (collections) shiur.collections = collections;
  if (shiur.venueId && !shiur.venue)
    shiur.venue = venues.find((v) => v.id === shiur.venueId)?.name || '';
  if (shiur.views === undefined) shiur.views = views[id];
  return shiur;
}
