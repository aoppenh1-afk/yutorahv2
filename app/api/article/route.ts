import { normalize, upstream } from '@/lib/yutorah';
import type { RawShiur } from '@/lib/api-types';
const allowed = new Set([
  'download.yutorah.org',
  'shiurim.yutorah.net',
  'cdnyutorah.cachefly.net',
]);
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^[1-9]\d{0,8}$/.test(id))
    return Response.json({ error: 'Choose a valid article.' }, { status: 400 });
  try {
    const s = normalize(
      await upstream<RawShiur>('shiur/details?shiurID=' + id, 600),
    );
    let url = new URL(s.audio);
    if (s.format !== 'pdf' && !/\.pdf(?:\?|$)/i.test(s.audio))
      return Response.json(
        { error: 'This article has no PDF.' },
        { status: 404 },
      );
    let response: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (url.protocol !== 'https:' || !allowed.has(url.hostname))
        throw new Error('Unsupported article source.');
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has('location')
      ) {
        await response.body?.cancel();
        url = new URL(response.headers.get('location')!, url);
        continue;
      }
      break;
    }
    if (!response?.ok || !response.body)
      throw new Error('The article could not load.');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const c = await reader.read();
        if (c.done) break;
        size += c.value.byteLength;
        if (size > 30 * 1024 * 1024)
          throw new Error('This PDF is too large for the reader.');
        chunks.push(c.value);
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-'))
      throw new Error('The source did not return a PDF.');
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="yutorah-${id}.pdf"`,
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return Response.json(
      {
        error:
          'The PDF could not load. Please retry or use the original download.',
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
