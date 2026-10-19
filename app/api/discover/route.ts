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
    const savedOnly =
      params.get('cached') === '1' ||
      (options.period !== 'day' && options.period !== 'week');
    const data = await (savedOnly ? savedCharts : discover)(options);
    const refreshing = data.stale || data.refreshing;
    const {
      seen: _coverage,
      index: _index,
      nextId: _id,
      nextPage: _page,
      ...publicData
    } = data;
    return Response.json(publicData, {
      headers: {
        // Saved complete charts already remain visible during a scan. Share
        // them briefly, keeping their labels and timestamp. Live requests must
        // continue advancing scans, and partial results stay uncached.
        'Cache-Control':
          data.partial || (refreshing && !savedOnly)
            ? 'no-store'
            : refreshing
              ? 'public, max-age=0, s-maxage=30'
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
