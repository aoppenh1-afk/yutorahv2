import { getRelatedCandidates } from '@/lib/discovery';

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^\d{1,9}$/.test(id) || Number(id) <= 0)
    return Response.json(
      { error: 'A valid shiur ID is required.' },
      { status: 400 },
    );
  try {
    return Response.json(await getRelatedCandidates(Number(id)), {
      headers: { 'Cache-Control': 'public, max-age=180' },
    });
  } catch {
    return Response.json(
      { error: 'Related shiurim could not load. Please try again.' },
      { status: 502 },
    );
  }
}
