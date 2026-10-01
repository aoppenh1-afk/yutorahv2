import { transcriptGateway } from '../../../lib/transcript-gateway';
/** Same-origin bridge to the VM's read-only PostgreSQL search endpoint. */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const q = p.get('q') || '';
  const mode = ['terms', 'phrase'].includes(p.get('mode') || '')
    ? p.get('mode')!
    : 'smart';
  if (!q.trim() || q.length > 200 || q.trim().split(/\s+/).length > 16)
    return Response.json(
      { error: 'Enter up to sixteen search words.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return transcriptGateway(
    '/v1/transcripts/search',
    new URLSearchParams({ q, mode, limit: '20' }),
  );
}
