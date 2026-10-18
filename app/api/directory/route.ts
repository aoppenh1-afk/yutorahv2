import { getCatalogService, deferCatalogWork } from '@/lib/catalog-server';
import { compactDirectory } from '@/lib/directory-payload';
export async function GET(request: Request) {
  const started = performance.now();
  try {
    let source = 'unknown';
    const { value: directory } = await (
      await getCatalogService()
    ).directory({
      defer: deferCatalogWork,
      onRead: (value) => {
        source = value;
      },
    });
    const compact = new URL(request.url).searchParams.get('compact') === '1';
    const data = compact ? compactDirectory(directory) : directory;
    return Response.json(data, {
      headers: {
        'Cache-Control':
          'public,max-age=1800,s-maxage=1800,stale-while-revalidate=1800',
        'Server-Timing': `directory;dur=${(performance.now() - started).toFixed(1)}`,
        'X-Yutorah-Cache': source,
      },
    });
  } catch {
    return Response.json(
      { error: 'The directory could not be loaded. Please try again.' },
      { status: 502 },
    );
  }
}
