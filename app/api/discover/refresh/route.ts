import { env } from 'cloudflare:workers';
import { transferAuthorized } from '@/lib/title-transfer';
import { parseTrendingOptions, TrendingChangedError } from '@/lib/trending';
import { createTrendingService, TrendingBusyError } from '@/lib/trending-cache';
import { searchDatabase } from '@/lib/search-db';

const refresh = createTrendingService({
  database: searchDatabase,
  requireStorage: true,
});
const headers = { 'Cache-Control': 'no-store' };

/** A job runner advances the existing durable scan without a browser open. */
export async function POST(request: Request) {
  const token = (env as unknown as { TRENDING_REFRESH_TOKEN?: string })
    .TRENDING_REFRESH_TOKEN;
  if (!(await transferAuthorized(request, token, !!token)))
    return Response.json({ error: 'Not found.' }, { status: 404, headers });
  try {
    const options = parseTrendingOptions(new URL(request.url).searchParams);
    // A background build must have persistent storage shared with chart reads.
    await searchDatabase().prepare('SELECT 1').first();
    const data = await refresh(options);
    const {
      seen: _seen,
      index: _index,
      nextId: _id,
      nextPage: _page,
      ...chart
    } = data;
    return Response.json(chart, { headers });
  } catch (error) {
    if (error instanceof RangeError)
      return Response.json({ error: error.message }, { status: 400, headers });
    if (
      error instanceof TrendingBusyError ||
      error instanceof TrendingChangedError
    )
      return Response.json(
        { error: error.message },
        {
          status: 503,
          headers: { ...headers, 'Retry-After': '30' },
        },
      );
    return Response.json(
      { error: 'Trending refresh failed; retry to resume saved progress.' },
      {
        status: 503,
        headers: { ...headers, 'Retry-After': '30' },
      },
    );
  }
}
