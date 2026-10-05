import { createShiurAutocomplete } from '@/lib/shiur-autocomplete';
import { searchDatabase } from '@/lib/search-db';
import { searchText } from '@/lib/search-matching';

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
    return Response.json(
      { items: await suggest(searchDatabase(), query) },
      {
        headers: {
          'Cache-Control':
            'public, max-age=60, s-maxage=300, stale-while-revalidate=300',
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RangeError
            ? error.message
            : 'Shiur suggestions are unavailable.',
      },
      {
        status: error instanceof RangeError ? 400 : 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
