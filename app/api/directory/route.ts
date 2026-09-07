import { getDirectory } from '@/lib/yutorah';
export async function GET() {
  try {
    return Response.json(await getDirectory(), {
      headers: { 'Cache-Control': 'public,max-age=1800' },
    });
  } catch {
    return Response.json(
      { error: 'The directory could not be loaded. Please try again.' },
      { status: 502 },
    );
  }
}
