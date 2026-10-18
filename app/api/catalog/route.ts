import { catalogDictionary, type CatalogKind } from '@/lib/catalog';
import { dafTractates } from '@/lib/daf';
import { getCatalogService, deferCatalogWork } from '@/lib/catalog-server';
import {
  SnapshotBusyError,
  SnapshotExpiredError,
} from '@/lib/public-snapshots';
import type { CollectionOrder } from '@/lib/catalog-pages';
const kinds = ['teacher', 'series', 'topic', 'venue', 'collection'];
export async function GET(request: Request) {
  const started = performance.now();
  const p = new URL(request.url).searchParams;
  const version = p.get('version') || '';
  if (version && !/^[a-f0-9]{64}$/.test(version))
    return Response.json(
      { error: 'Choose a valid collection version.' },
      { status: 400 },
    );
  const options = {
    version,
    fresh: p.get('fresh') === '1',
    defer: deferCatalogWork,
  };
  const action = p.get('action') || 'directory',
    kind = p.get('kind') as CatalogKind;
  try {
    const catalogService = await getCatalogService();
    let data: unknown;
    if (action === 'facets') {
      const dictionary = await catalogDictionary();
      data = { ...dictionary, publications: [], volumes: [] };
    } else if (action === 'daf') {
      const tractate = p.get('tractate') || '',
        page = Number(p.get('page')),
        side = p.get('side');
      if (
        !/^[A-Za-z][A-Za-z '-]{1,50}$/.test(tractate) ||
        !Number.isInteger(page) ||
        page < 2 ||
        page > 200 ||
        !['a', 'b'].includes(side || '')
      )
        return Response.json({ error: 'Choose a valid daf.' }, { status: 400 });
      if (!dafTractates.some((t) => t.name === tractate && page <= t.lastPage))
        return Response.json(
          { error: 'Choose a valid tractate and page.' },
          { status: 400 },
        );
      data = (
        await catalogService.daf(tractate, page, side as 'a' | 'b', options)
      ).value;
    } else {
      if (!kinds.includes(kind))
        return Response.json(
          { error: 'Choose a library section.' },
          { status: 400 },
        );
      if (['entity', 'neighbors', 'related'].includes(action)) {
        const id = Number(p.get('id'));
        if (!Number.isSafeInteger(id) || id <= 0 || id > 1_000_000)
          return Response.json(
            { error: 'Choose a valid library page.' },
            { status: 400 },
          );
        if (action === 'neighbors') {
          const shiur = Number(p.get('shiur'));
          if (
            kind !== 'collection' ||
            !Number.isSafeInteger(shiur) ||
            shiur <= 0 ||
            shiur > 999_999_999
          )
            throw new RangeError('Choose a valid collection lesson.');
          data = await catalogService.neighbors(id, shiur, options);
        } else if (action === 'related') {
          if (kind !== 'collection')
            throw new RangeError('Choose a collection.');
          data = await catalogService.related(id, options);
        } else
          data =
            kind === 'collection'
              ? await catalogService.collectionPage(
                  id,
                  {
                    offset: Number(p.get('offset') || 0),
                    limit: Number(p.get('limit') || 60),
                    query: p.get('q') || '',
                    order: (p.get('sort') || 'old') as CollectionOrder,
                  },
                  options,
                )
              : (await catalogService.landing(kind, id, options)).value;
      } else if (action === 'directory') {
        const q = p.get('q') || '',
          offset = Number(p.get('offset') || 0);
        if (
          q.length > 100 ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > 50000
        )
          return Response.json(
            { error: 'Choose a valid directory search.' },
            { status: 400 },
          );
        data = await catalogService.browse(kind, q, offset, options);
      } else
        return Response.json(
          { error: 'Unknown library request.' },
          { status: 400 },
        );
    }
    return Response.json(data, {
      headers: {
        'Cache-Control':
          options.fresh ||
          (data && typeof data === 'object' && 'unavailable' in data)
            ? 'no-store'
            : version
              ? 'public, max-age=300, s-maxage=300'
              : 'public, max-age=60, s-maxage=300, stale-while-revalidate=300',
        'Server-Timing': `catalog;dur=${(performance.now() - started).toFixed(1)}`,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'The library could not load. Please retry.',
      },
      {
        status:
          error instanceof RangeError
            ? 400
            : error instanceof SnapshotExpiredError
              ? 409
              : error instanceof SnapshotBusyError
                ? 503
                : 502,
        headers: {
          'Cache-Control': 'no-store',
          ...(error instanceof SnapshotBusyError ? { 'Retry-After': '1' } : {}),
        },
      },
    );
  }
}
