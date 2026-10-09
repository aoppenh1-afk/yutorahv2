import { getShiurViews } from '@/lib/shiur-views';

export async function GET(request: Request) {
  const input = new URL(request.url).searchParams.get('ids');
  const ids = input?.split(',') ?? [];
  if (
    !ids.length ||
    ids.length > 24 ||
    ids.some((id) => !/^[1-9]\d{0,8}$/.test(id))
  )
    return Response.json(
      { error: 'Provide up to 24 valid shiur IDs.' },
      { status: 400 },
    );
  const views = await getShiurViews(ids.map(Number));
  return Response.json({ views }, { headers: { 'Cache-Control': 'no-store' } });
}
