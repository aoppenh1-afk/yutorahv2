import type { Shiur } from './yutorah';
/** Enrichment must not erase fields already supplied by a search or collection. */
export function mergeShiurDetails<T extends Shiur>(previous: T, fresh: T): T {
  return {
    ...previous,
    ...fresh,
    views: fresh.views ?? previous.views,
    topics: fresh.topics.length ? fresh.topics : previous.topics,
    category: fresh.category || previous.category,
    series: fresh.series || previous.series,
    seriesId: fresh.seriesId || previous.seriesId,
    uploadedAt: fresh.uploadedAt || previous.uploadedAt,
    collections: fresh.collections?.length
      ? fresh.collections
      : previous.collections,
    publicationId: fresh.publicationId || previous.publicationId,
    publication: fresh.publication || previous.publication,
    volumeId: fresh.volumeId || previous.volumeId,
    volume: fresh.volume || previous.volume,
  };
}
