import type { RawShiur } from '@/lib/api-types';
import { normalize, upstream, plain, safeUrl } from '@/lib/yutorah';
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^\d{1,9}$/.test(id))
    return Response.json(
      { error: 'A valid shiur ID is required.' },
      { status: 400 },
    );
  try {
    const raw = await upstream<RawShiur>('shiur/details?shiurID=' + id, 600);
    if (!raw?.shiurID)
      return Response.json(
        { error: 'This shiur could not be found.' },
        { status: 404 },
      );
    const shiur = normalize(raw);
    return Response.json(
      {
        ...shiur,
        text: plain(raw.shiurText),
        video: safeUrl(
          (raw.shiurDescription || '').match(
            /https?:\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/watch\?v=)[a-zA-Z0-9_-]+/,
          )?.[0] ||
            raw.shiurPlayerURL ||
            (shiur.format === 'mp4' ? shiur.audio : ''),
        ),
        materials: (raw.shiurMaterials || [])
          .map((m) => ({
            name: plain(m.name || m.title || m.materialName),
            url: safeUrl(m.url || m.fileURL || m.materialURL),
          }))
          .filter((m) => m.url),
      },
      { headers: { 'Cache-Control': 'public,max-age=300' } },
    );
  } catch {
    return Response.json(
      { error: 'This shiur could not be loaded. Please try again.' },
      { status: 502 },
    );
  }
}
