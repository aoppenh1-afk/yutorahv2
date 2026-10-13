import type { Shiur } from './yutorah';
import { MAX_DOWNLOAD_BYTES } from './download-contract';

const hosts = new Set([
  'download.yutorah.org',
  'shiurim.yutorah.net',
  'cdnyutorah.cachefly.net',
]);
export function allowedAudioUrl(input: string) {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    !hosts.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    throw new Error('Unsupported recording source.');
  return url;
}
export function audioSignature(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes.subarray(0, 12));
  return (
    text.startsWith('ID3') ||
    text.startsWith('OggS') ||
    text.startsWith('fLaC') ||
    (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') ||
    text.slice(4, 8) === 'ftyp' ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  );
}
/** Resolve media by shiur ID. Never accept a caller-supplied proxy URL. */
export async function relayAudio(
  shiur: Shiur,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  let url = allowedAudioUrl(shiur.audio);
  let response: Response | undefined;
  for (let redirects = 0; redirects < 4; redirects++) {
    response = await fetcher(url, {
      redirect: 'manual',
      signal,
      headers: { Accept: 'audio/*, application/octet-stream' },
    });
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has('location')
    ) {
      await response.body?.cancel();
      url = allowedAudioUrl(
        new URL(response.headers.get('location')!, url).href,
      );
      response = undefined;
      continue;
    }
    break;
  }
  if (!response?.ok || response.status !== 200 || !response.body) {
    await response?.body?.cancel();
    throw new Error('The recording could not be downloaded. Try again.');
  }
  const type =
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ||
    '';
  if (
    !type.startsWith('audio/') &&
    !['application/octet-stream', 'binary/octet-stream'].includes(type)
  ) {
    await response.body.cancel();
    throw new Error('The source did not return an audio recording.');
  }
  const length = Number(response.headers.get('content-length')) || 0;
  if (length > MAX_DOWNLOAD_BYTES) {
    await response.body.cancel();
    throw new Error(
      'This recording is too large to download in the app. Use Download file instead.',
    );
  }
  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  let count = 0;
  try {
    while (count < 12) {
      const chunk = await reader.read();
      if (chunk.done) break;
      prefix.push(chunk.value);
      count += chunk.value.byteLength;
    }
    const signature = new Uint8Array(Math.min(count, 12));
    let offset = 0;
    for (const chunk of prefix) {
      const part = chunk.subarray(0, signature.length - offset);
      signature.set(part, offset);
      offset += part.length;
      if (offset === signature.length) break;
    }
    if (!count || !audioSignature(signature))
      throw new Error('The source did not return a playable audio recording.');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const mime = type.startsWith('audio/')
    ? type
    : /\.(m4a|mp4)(?:\?|$)/i.test(url.href)
      ? 'audio/mp4'
      : 'audio/mpeg';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          if (length && count !== length)
            throw new Error('The download was interrupted.');
          controller.close();
          reader.releaseLock();
          return;
        }
        count += chunk.value.byteLength;
        if (count > MAX_DOWNLOAD_BYTES)
          throw new Error(
            'This recording is too large to download in the app.',
          );
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await reader.cancel().catch(() => {});
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const headers = new Headers({
    'Content-Type': mime,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (length) headers.set('Content-Length', String(length));
  return new Response(stream, { headers });
}
