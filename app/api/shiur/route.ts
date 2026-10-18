import { shiurCore, shiurEnrichment } from '@/lib/shiur-details';
import { getCatalogService, deferCatalogWork } from '@/lib/catalog-server';
import { SnapshotBusyError } from '@/lib/public-snapshots';

export async function GET(request: Request) {
  const started = performance.now();
  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  if (!id || !/^[1-9]\d{0,8}$/.test(id))
    return Response.json(
      { error: 'A valid shiur ID is required.' },
      { status: 400 },
    );
  const part = params.get('part') || 'full';
  if (!['core', 'full'].includes(part))
    return Response.json(
      { error: 'Choose a valid shiur request.' },
      { status: 400 },
    );
  try {
    let source = 'unknown';
    const service = await getCatalogService();
    const result = await service.snapshots.read(
      `shiur:${part}:${id}`,
      async () => {
        const data = await (part === 'core' ? shiurCore : shiurEnrichment)(
          Number(id),
        );
        if (!data) throw new RangeError('This shiur could not be found.');
        return data;
      },
      {
        ttl: part === 'core' ? 600_000 : 300_000,
        defer: deferCatalogWork,
        onRead: (value) => {
          source = value;
        },
      },
    );
    return Response.json(result.value, {
      headers: {
        'Cache-Control':
          'public,max-age=300,s-maxage=300,stale-while-revalidate=300',
        'Server-Timing': `shiur;dur=${(performance.now() - started).toFixed(1)}`,
        'X-Yutorah-Cache': source,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RangeError
            ? error.message
            : 'This shiur could not be loaded. Please try again.',
      },
      {
        status:
          error instanceof RangeError
            ? 404
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
