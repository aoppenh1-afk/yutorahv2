import { sourceFeatures } from '../../../../lib/source-features';
import { verifyManualSource } from '../../../../lib/source-manual';

export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!sourceFeatures().sheets && !sourceFeatures().links)
    return Response.json(
      { error: 'Source creation is turned off.' },
      { status: 404, headers },
    );
  if (Number(request.headers.get('Content-Length')) > 2048)
    return Response.json(
      { error: 'Enter a shorter reference.' },
      { status: 413, headers },
    );
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json(
      { error: 'Enter a reference.' },
      { status: 400, headers },
    );
  let raw = '',
    bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2048) {
        await reader.cancel();
        return Response.json(
          { error: 'Enter a shorter reference.' },
          { status: 413, headers },
        );
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return Response.json(
      { error: 'Enter a reference.' },
      { status: 400, headers },
    );
  }
  if (typeof data?.ref !== 'string')
    return Response.json(
      { error: 'Enter a reference.' },
      { status: 400, headers },
    );
  try {
    const source = await verifyManualSource(data.ref);
    return source
      ? Response.json(source, { headers })
      : Response.json(
          {
            error:
              'Include the work and a numbered location, such as Genesis 1:1.',
          },
          { status: 422, headers },
        );
  } catch {
    return Response.json(
      { error: 'Sefaria could not verify this reference. Try again.' },
      { status: 503, headers },
    );
  }
}
