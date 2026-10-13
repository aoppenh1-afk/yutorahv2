import {
  catalogCollection,
  catalogDaf,
  catalogDictionary,
  catalogDirectory,
  catalogLanding,
  type CatalogKind,
} from '@/lib/catalog';
import { dafTractates } from '@/lib/daf';
const kinds = ['teacher', 'series', 'topic', 'venue', 'collection'];
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const action = p.get('action') || 'directory',
    kind = p.get('kind') as CatalogKind;
  try {
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
      data = await catalogDaf(tractate, page, side as 'a' | 'b');
    } else {
      if (!kinds.includes(kind))
        return Response.json(
          { error: 'Choose a library section.' },
          { status: 400 },
        );
      if (action === 'entity') {
        const id = Number(p.get('id'));
        if (!Number.isSafeInteger(id) || id <= 0 || id > 1_000_000)
          return Response.json(
            { error: 'Choose a valid library page.' },
            { status: 400 },
          );
        data =
          kind === 'collection'
            ? await catalogCollection(id)
            : await catalogLanding(kind, id);
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
        data = await catalogDirectory(kind, q, offset);
      } else
        return Response.json(
          { error: 'Unknown library request.' },
          { status: 400 },
        );
    }
    return Response.json(data, {
      headers: {
        'Cache-Control':
          data && typeof data === 'object' && 'unavailable' in data
            ? 'no-store'
            : 'public, max-age=60, s-maxage=300',
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
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
