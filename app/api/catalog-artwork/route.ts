import { catalogCollectionArtwork } from '@/lib/catalog';

// Images load only when their cards approach the viewport. Do not fan out
// collection-detail requests to enrich an entire directory page eagerly.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = Number(params.get('id')),
    format = params.get('format') || '';
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    id > 1_000_000 ||
    !['', 'json'].includes(format)
  )
    return new Response(null, { status: 400 });
  try {
    const image = await catalogCollectionArtwork(id);
    if (format === 'json')
      return Response.json(
        { image },
        { headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' } },
      );
    if (image)
      return new Response(null, {
        status: 302,
        headers: {
          Location: image,
          'Cache-Control': 'public, max-age=3600, s-maxage=3600',
        },
      });
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': 'public, max-age=600' },
    });
  } catch {
    return new Response(null, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
