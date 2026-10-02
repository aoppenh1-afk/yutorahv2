import { parseTrendingOptions, TrendingChangedError } from '@/lib/trending';
import { createTrendingService, TrendingBusyError } from '@/lib/trending-cache';
import { searchDatabase } from '@/lib/search-db';

const discover = createTrendingService({ database: searchDatabase });

export async function GET(request: Request) {
  try {
    const options = parseTrendingOptions(new URL(request.url).searchParams);
    const data = await discover(options);
    return Response.json(data, {
      headers: {
        'Cache-Control':
          data.stale || data.partial
            ? 'no-store'
            : 'public, max-age=60, s-maxage=300, stale-while-revalidate=300',
        'X-Trending-Fetched-At': data.fetchedAt,
      },
    });
  } catch (error) {
    if (error instanceof RangeError)
      return Response.json({ error: error.message }, { status: 400 });
    if (
      error instanceof TrendingBusyError ||
      error instanceof TrendingChangedError
    )
      return Response.json(
        { error: error.message },
        {
          status: 503,
          headers: {
            'Retry-After': error instanceof TrendingChangedError ? '30' : '5',
            'Cache-Control': 'no-store',
          },
        },
      );
    return Response.json(
      { error: 'Trending shiurim could not load. Please try again.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
