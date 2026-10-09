import { parseTrendingOptions, TrendingChangedError } from '@/lib/trending';
import { createTrendingService, TrendingBusyError } from '@/lib/trending-cache';
import { searchDatabase } from '@/lib/search-db';

const discover = createTrendingService({ database: searchDatabase });
const savedCharts = createTrendingService({
  database: searchDatabase,
  cachedOnly: true,
});

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const options = parseTrendingOptions(params);
    const data = await (
      params.get('cached') !== '1' &&
        (options.period === 'day' || options.period === 'week')
        ? discover
        : savedCharts
    )(options);
    const {
      seen: _coverage,
      index: _index,
      nextId: _id,
      nextPage: _page,
      ...publicData
    } = data;
    return Response.json(publicData, {
      headers: {
        'Cache-Control':
          data.stale || data.partial || data.refreshing
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
    console.warn(
      'Trending refresh failed:',
      error instanceof Error ? error.message : 'Unknown source failure.',
    );
    return Response.json(
      { error: 'Trending shiurim could not load. Please try again.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
