import { websiteTranscript } from '../../../lib/website-transcript';
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^\d{1,12}$/.test(id))
    return Response.json(
      { error: 'Choose a valid shiur.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  const params = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();
  if (params.get('fresh') === 'true') forwarded.set('fresh', 'true');
  if (params.has('source')) forwarded.set('source', params.get('source')!);
  if (/^[a-f0-9]{64}$/.test(params.get('version') ?? ''))
    forwarded.set('version', params.get('version')!);
  return websiteTranscript(
    id,
    forwarded,
    request.headers.get('If-None-Match') || undefined,
  );
}
