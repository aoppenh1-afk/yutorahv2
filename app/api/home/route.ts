import { getHome } from '@/lib/yutorah';
export async function GET() {
  try {
    return Response.json(await getHome(), {
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  } catch {
    return Response.json(
      { error: 'YUTorah is temporarily unavailable. Please try again.' },
      { status: 502 },
    );
  }
}
