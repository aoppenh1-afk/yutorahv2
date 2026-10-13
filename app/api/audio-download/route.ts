import { normalize, upstream, mediaKind } from '@/lib/yutorah';
import type { RawShiur } from '@/lib/api-types';
import { relayAudio } from '@/lib/audio-download';

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^[1-9]\d{0,8}$/.test(id))
    return Response.json({ error: 'Choose a valid shiur.' }, { status: 400 });
  // This is an app download endpoint, not a public cross-origin media proxy.
  const origin = request.headers.get('origin');
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return Response.json(
      { error: 'Open this shiur on YUTorah to download it.' },
      { status: 403 },
    );
  try {
    const shiur = normalize(
      await upstream<RawShiur>('shiur/details?shiurID=' + id, 600),
    );
    if (shiur.id !== Number(id) || mediaKind(shiur) !== 'audio' || !shiur.audio)
      return Response.json(
        { error: 'This shiur has no audio recording to download.' },
        { status: 404 },
      );
    return await relayAudio(
      shiur,
      AbortSignal.any([request.signal, AbortSignal.timeout(10 * 60_000)]),
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'The recording could not be downloaded. Try again.',
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
