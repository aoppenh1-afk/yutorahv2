/** Same-origin bridge to the VM's read-only PostgreSQL search endpoint. */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const q = p.get('q') || '';
  const mode = p.get('mode') === 'terms' ? 'terms' : 'phrase';
  if (!q.trim() || q.length > 200 || q.trim().split(/\s+/).length > 16)
    return Response.json({ error: 'Enter up to sixteen search words.' }, { status: 400 });
  const base = process.env.TRANSCRIPT_API_URL;
  const token = process.env.TRANSCRIPT_API_TOKEN;
  if (!base || !token)
    return Response.json(
      { error: 'Transcript search is not configured yet.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  let target: URL;
  try {
    target = new URL('/v1/transcripts/search', base);
    if (target.protocol !== 'https:' && target.hostname !== '127.0.0.1')
      throw new Error('HTTPS required');
  } catch {
    return Response.json(
      { error: 'Transcript search is not configured yet.' },
      { status: 503 },
    );
  }
  target.searchParams.set('q', q);
  target.searchParams.set('mode', mode);
  target.searchParams.set('limit', '20');
  try {
    const upstream = await fetch(target, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (upstream.status === 400)
      return Response.json(
        { error: 'Try different search words.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    if (!upstream.ok) throw new Error('Search gateway failed');
    return Response.json(await upstream.json(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json(
      { error: 'Transcript search is temporarily unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
