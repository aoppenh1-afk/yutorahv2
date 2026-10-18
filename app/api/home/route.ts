import { getCatalogService, deferCatalogWork } from '@/lib/catalog-server';
export async function GET() {
  const started = performance.now();
  try {
    return Response.json(
      (await (await getCatalogService()).home({ defer: deferCatalogWork }))
        .value,
      {
        headers: {
          'Cache-Control':
            'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
          'Server-Timing': `home;dur=${(performance.now() - started).toFixed(1)}`,
        },
      },
    );
  } catch {
    console.error(
      JSON.stringify({
        event: 'homepage_unavailable',
        durationMs: performance.now() - started,
      }),
    );
    return Response.json(
      { error: 'YUTorah is temporarily unavailable. Please try again.' },
      { status: 502 },
    );
  }
}
