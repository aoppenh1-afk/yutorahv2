import {
  createShiurAutocomplete,
  titleAutocompleteQuery,
} from '@/lib/shiur-autocomplete';
import { searchDatabase } from '@/lib/search-db';
import { searchText } from '@/lib/search-matching';
import { combineSearchSuggestions } from '@/lib/search-discovery';
import { getCatalogService, deferCatalogWork } from '@/lib/catalog-server';

const suggest = createShiurAutocomplete();

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q') || '';
  if (query.length > 300)
    return Response.json(
      { error: 'Please use a shorter search.' },
      { status: 400 },
    );
  if (searchText(query).length < 3) return Response.json({ items: [] });
  try {
    titleAutocompleteQuery(query);
    const [titles, catalog] = await Promise.allSettled([
      Promise.resolve().then(() => suggest(searchDatabase(), query)),
      getCatalogService().then((service) =>
        service.suggestions(query, { defer: deferCatalogWork }),
      ),
    ]);
    if (titles.status === 'rejected' && catalog.status === 'rejected')
      throw titles.reason;
    const partial =
      titles.status === 'rejected' ||
      catalog.status === 'rejected' ||
      catalog.value.partial;
    return Response.json(
      {
        items: combineSearchSuggestions(
          catalog.status === 'fulfilled' ? catalog.value.items : [],
          titles.status === 'fulfilled' ? titles.value : [],
          query,
        ),
        ...(partial ? { partial: true } : {}),
      },
      {
        headers: {
          'Cache-Control': partial
            ? 'no-store'
            : 'public, max-age=60, s-maxage=300, stale-while-revalidate=300',
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RangeError
            ? error.message
            : 'Search suggestions are unavailable.',
      },
      {
        status: error instanceof RangeError ? 400 : 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
