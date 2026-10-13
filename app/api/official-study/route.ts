import { officialStudy } from '@/lib/official-study';
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^[1-9]\d{0,8}$/.test(id))
    return Response.json({ error: 'Choose a valid shiur.' }, { status: 400 });
  try {
    return Response.json(
      await officialStudy(
        Number(id),
        new URL(request.url).searchParams.get('fresh') === '1',
      ),
      {
        headers: {
          'Cache-Control':
            new URL(request.url).searchParams.get('fresh') === '1'
              ? 'no-store'
              : 'public, max-age=60, s-maxage=300',
        },
      },
    );
  } catch {
    return Response.json(
      { error: 'YUTorah chapters and summaries could not load. Please retry.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
