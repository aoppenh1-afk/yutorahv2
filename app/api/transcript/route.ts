import { transcriptGateway } from '../../../lib/transcript-gateway';
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^\d{1,12}$/.test(id))
    return Response.json(
      { error: 'Choose a valid shiur.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return transcriptGateway(`/v1/transcripts/${id}`, new URLSearchParams());
}
