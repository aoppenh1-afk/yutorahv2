import type { SearchDatabase } from './search-storage';
import {
  createPublicSnapshots,
  type DeferPublicWork,
  type SnapshotObservation,
} from './public-snapshots';
import {
  catalogCollection,
  catalogCollectionArtwork,
  catalogRelatedCollections,
  catalogDirectory,
  catalogLanding,
  catalogDaf,
  type CatalogKind,
  type CatalogEntry,
} from './catalog';
import { getHome, getDirectory } from './yutorah';
import { pageCollection, collectionNeighbors } from './catalog-pages';
import {
  combineSearchSuggestions,
  suggestCollections,
  suggestSearch,
} from './search-discovery';
import { findCatalogSearchMatches } from './search-results';

type ReadOptions = SnapshotObservation & {
  fresh?: boolean;
  version?: string;
  defer?: DeferPublicWork;
};
/** All public catalog consumers share durable snapshots and the cover manifest. */
export function createCatalogService({
  database,
  now = Date.now,
}: { database?: () => SearchDatabase; now?: () => number } = {}) {
  const snapshots = createPublicSnapshots({ database, now });
  async function rememberArtwork(id: number, image: string) {
    const db = database?.();
    if (db)
      await db
        .prepare(`INSERT INTO catalog_artwork(id,image,updated) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET image=excluded.image,updated=excluded.updated`)
        .bind(id, image, now())
        .run()
        .catch(() => undefined);
  }
  async function artwork(id: number, options: ReadOptions = {}) {
    const db = database?.();
    const hit =
      !options.fresh && db
        ? await db
            .prepare('SELECT image,updated FROM catalog_artwork WHERE id=?')
            .bind(id)
            .first<{ image: string; updated: number }>()
            .catch(() => null)
        : null;
    if (hit && hit.updated > now() - 24 * 60 * 60_000) return hit.image;
    const image = await catalogCollectionArtwork(id);
    await rememberArtwork(id, image);
    return image;
  }
  async function collection(id: number, options: ReadOptions = {}) {
    return snapshots.read(
      'collection:' + id,
      async () => {
        const data = await catalogCollection(id, false);
        const ids = new Set(data.items.map((s) => s.id));
        if (
          ids.size !== data.items.length ||
          data.items.some((s) => !Number.isSafeInteger(s.id) || s.id <= 0)
        )
          throw new Error(
            'The collection returned duplicate or invalid lessons.',
          );
        await rememberArtwork(id, data.image);
        return data;
      },
      { ttl: 15 * 60_000, ...options },
    );
  }
  const directory = (options: ReadOptions = {}) =>
    snapshots.read('directory', getDirectory, { ttl: 30 * 60_000, ...options });
  const browseDirectory = (kind: CatalogKind, options: ReadOptions = {}) =>
    snapshots.read(
      'browse:' + kind,
      () => catalogDirectory(kind, '', 0, true),
      { ttl: 30 * 60_000, ...options },
    );
  const bounded = <T>(
    request: Promise<T>,
    options: ReadOptions,
    timeoutMs: number,
  ) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        options.defer?.(() => request.catch(() => undefined));
        reject(new Error('Catalog search timed out.'));
      }, timeoutMs);
      request.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  return {
    snapshots,
    collection,
    artwork,
    home: (options: ReadOptions = {}) =>
      snapshots.read('home', getHome, { ttl: 60_000, ...options }),
    directory,
    async suggestions(
      query: string,
      options: ReadOptions & { timeoutMs?: number } = {},
    ) {
      // A cold or unavailable catalog must not hold up indexed shiur titles.
      // The request lifecycle can finish warming snapshots after the response.
      const [names, collections] = await Promise.allSettled([
        bounded(directory(options), options, options.timeoutMs ?? 1500),
        bounded(
          browseDirectory('collection', options),
          options,
          options.timeoutMs ?? 1500,
        ),
      ]);
      if (names.status === 'rejected' && collections.status === 'rejected')
        throw names.reason;
      return {
        items: combineSearchSuggestions(
          names.status === 'fulfilled'
            ? suggestSearch(query, names.value.value)
            : [],
          collections.status === 'fulfilled'
            ? suggestCollections(query, collections.value.value.entries)
            : [],
          query,
        ),
        partial:
          names.status === 'rejected' || collections.status === 'rejected',
      };
    },
    async search(query: string, offset = 0, options: ReadOptions = {}) {
      if (
        query.length > 300 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 50000
      )
        throw new RangeError('Choose a valid library search.');
      if (query.trim().length < 2)
        return { items: [], total: 0, next: null, partial: false };
      const [names, collections, venues] = await Promise.allSettled([
        bounded(directory(options), options, 8000),
        bounded(browseDirectory('collection', options), options, 8000),
        bounded(browseDirectory('venue', options), options, 8000),
      ]);
      if (
        names.status === 'rejected' &&
        collections.status === 'rejected' &&
        venues.status === 'rejected'
      )
        throw names.reason;
      const items = findCatalogSearchMatches(
        query,
        names.status === 'fulfilled' ? names.value.value : null,
        collections.status === 'fulfilled'
          ? collections.value.value.entries
          : [],
        venues.status === 'fulfilled' ? venues.value.value.entries : [],
      );
      return {
        items: items.slice(offset, offset + 60),
        total: items.length,
        next: offset + 60 < items.length ? offset + 60 : null,
        partial:
          names.status === 'rejected' ||
          collections.status === 'rejected' ||
          venues.status === 'rejected',
      };
    },
    landing: (
      kind: Exclude<CatalogKind, 'collection'>,
      id: number,
      options: ReadOptions = {},
    ) =>
      snapshots.read(`landing:${kind}:${id}`, () => catalogLanding(kind, id), {
        ttl: 300_000,
        ...options,
      }),
    daf: (
      tractate: string,
      page: number,
      side: 'a' | 'b',
      options: ReadOptions = {},
    ) =>
      snapshots.read(
        `daf:${tractate}:${page}:${side}`,
        () => catalogDaf(tractate, page, side),
        { ttl: 600_000, ...options },
      ),
    async collectionPage(
      id: number,
      page: Parameters<typeof pageCollection>[2] = {},
      options: ReadOptions = {},
    ) {
      const snapshot = await collection(id, options);
      return {
        ...pageCollection(snapshot.value, snapshot.version, {
          ...page,
          stale: snapshot.stale,
        }),
        preparedAt: snapshot.updated,
      };
    },
    async neighbors(id: number, shiur: number, options: ReadOptions = {}) {
      const snapshot = await collection(id, options);
      return collectionNeighbors(snapshot.value, snapshot.version, shiur);
    },
    async related(id: number, options: ReadOptions = {}) {
      const snapshot = await collection(id, options);
      return {
        entries: snapshot.value.teacherId
          ? await catalogRelatedCollections(id, snapshot.value.teacherId)
          : [],
      };
    },
    async browse(
      kind: CatalogKind,
      query = '',
      offset = 0,
      options: ReadOptions = {},
    ) {
      const snapshot = await browseDirectory(kind, options);
      const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const filtered = snapshot.value.entries.filter((e) =>
        words.every((word) =>
          [e.name, e.group, ...(e.path || [])]
            .join(' ')
            .toLocaleLowerCase()
            .includes(word),
        ),
      );
      const entries: CatalogEntry[] = filtered.slice(offset, offset + 36);
      const db = database?.();
      if (kind === 'collection' && db && entries.length) {
        const rows = (
          await db
            .prepare(
              `SELECT id,image FROM catalog_artwork WHERE id IN (${entries.map(() => '?').join(',')})`,
            )
            .bind(...entries.map((e) => e.id))
            .all<{ id: number; image: string }>()
            .catch(() => ({ results: [] }))
        ).results;
        const byId = new Map(rows.map((r) => [r.id, r.image]));
        for (const entry of entries)
          if (byId.has(entry.id)) {
            entry.image = byId.get(entry.id);
            entry.artworkKnown = true;
          }
      }
      return {
        kind,
        entries,
        total: filtered.length,
        next: offset + 36 < filtered.length ? offset + 36 : null,
        stale: snapshot.stale,
      };
    },
  };
}
