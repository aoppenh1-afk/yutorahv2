import { getDiscovery } from '@/lib/discovery';

export async function GET() {
  try {
    return Response.json(await getDiscovery(), {
      headers: { 'Cache-Control': 'public, max-age=180' },
    });
  } catch {
    return Response.json(
      { error: 'Trending shiurim could not load. Please try again.' },
      { status: 502 },
    );
  }
}
