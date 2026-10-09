import { hostedNotes } from '../../../lib/tidb-notes';
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[1-9]\d{0,11}$/.test(id))
    return Response.json(
      { error: 'Choose a valid shiur.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return hostedNotes(id, request.headers.get('If-None-Match') ?? undefined);
}
