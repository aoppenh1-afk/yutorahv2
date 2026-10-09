import { BoundedCache } from './bounded-cache';
import { parseVtt } from './webvtt.mjs';
import { publicationLimits } from '../packages/transcription/src/public-content';
import type { PublicContent } from '../packages/transcription/src/public-content';

type Metadata = { title: string; teacher: string; mediaUrl?: string };
export type OfficialContent = Omit<PublicContent, 'createdAt'> & {
  source: 'official-yutorah';
  sourceUrl: string;
  retrievedAt: string;
  version: string;
};
type Snapshot = { status: number; text: string; etag?: string };
const cacheControl =
  'public, max-age=60, s-maxage=300, stale-while-revalidate=60';

async function hash(text: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function boundedText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > publicationLimits.bytes)
        throw new Error('Transcript is too large.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Strip WebVTT formatting, then decode entities without interpreting HTML. */
function cueText(text: string) {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    nbsp: ' ',
    quot: '"',
    apos: "'",
  };
  return text
    .replace(
      /<\/?(?:b|i|u|c(?:\.[^ >]+)?|v(?: [^>]+)?|lang(?: [^>]+)?|ruby|rt)>|<(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}>/g,
      '',
    )
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|nbsp|quot|apos);/gi,
      (match, entity: string) => {
        if (!entity.startsWith('#'))
          return entities[entity.toLowerCase()] ?? match;
        const code =
          entity[1].toLowerCase() === 'x'
            ? Number.parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : match;
      },
    );
}

/** Read only the public VTT, with bounded caching and shared concurrent reads. */
export function createOfficialTranscriptReader(
  options: {
    fetcher?: typeof fetch;
    metadata?: (id: string) => Promise<Metadata>;
  } = {},
) {
  const cache = new BoundedCache<Snapshot>(32, 8 * 1024 * 1024);
  const pending = new Map<string, Promise<Snapshot>>();
  const fetcher = options.fetcher ?? ((...args) => fetch(...args));
  const missing = (): Snapshot => ({
    status: 404,
    text: JSON.stringify({ error: 'No completed transcript yet.' }),
  });

  async function load(id: string, fresh: boolean): Promise<Snapshot> {
    const sourceUrl = `https://api.yutorah.org/transcriptions/shiur/${id}/vtt`;
    const response = await fetcher(sourceUrl, {
      headers: { Accept: 'text/vtt' },
      signal: AbortSignal.timeout(8000),
      // Workers supports manual redirects; a 3xx response is rejected below.
      redirect: 'manual',
      ...(fresh ? { cache: 'no-store' as const } : {}),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return missing();
    }
    if (
      !response.ok ||
      !/^text\/vtt(?:;|$)/i.test(response.headers.get('Content-Type') ?? '')
    ) {
      await response.body?.cancel();
      throw new Error('Official transcript is unavailable.');
    }
    const vtt = await boundedText(response);
    const segments = parseVtt(vtt).map((cue) => ({
      ...cue,
      text: cueText(cue.text),
      speaker: null,
      language: null,
    }));
    if (!segments.length) return missing();
    if (
      segments.length > publicationLimits.segments ||
      segments.some(
        (s) =>
          !s.text.trim() || s.text.length > publicationLimits.segmentCharacters,
      )
    )
      throw new Error('Invalid official transcript.');
    const durationMs = segments.reduce(
      (end, cue) => Math.max(end, cue.endMs),
      0,
    );
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new Error('Invalid official transcript duration.');
    const version = await hash(vtt);
    let metadata: Metadata = {
      title: `YUTorah shiur ${id}`,
      teacher: 'YUTorah',
    };
    if (options.metadata) {
      try {
        metadata = await options.metadata(id);
      } catch {
        /* Text remains readable if metadata is unavailable. */
      }
    }
    const content: OfficialContent = {
      id,
      ...metadata,
      transcriptId: `official-${id}-${version.slice(0, 32)}`,
      durationMs,
      source: 'official-yutorah',
      sourceUrl,
      retrievedAt: new Date().toISOString(),
      version,
      segments,
      notes: null,
    };
    const text = JSON.stringify(content);
    if (new TextEncoder().encode(text).length > publicationLimits.bytes)
      throw new Error('Transcript is too large.');
    return { status: 200, text, etag: `"${await hash(text)}"` };
  }

  return async (id: string, params: URLSearchParams, etag?: string) => {
    if (!/^\d{1,12}$/.test(id))
      return Response.json(
        { error: 'Choose a valid shiur.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    const fresh = params.get('fresh') === 'true';
    try {
      let snapshot = fresh ? undefined : cache.get(id);
      if (!snapshot) {
        let request = pending.get(id);
        if (!request) {
          if (pending.size >= 8) throw new Error('Transcript reads are busy.');
          request = load(id, fresh)
            .then((result) => {
              cache.set(id, result, result.status === 200 ? 300_000 : 60_000);
              return result;
            })
            .finally(() => pending.delete(id));
          pending.set(id, request);
        }
        snapshot = await request;
      }
      if (
        snapshot.status === 200 &&
        params.has('version') &&
        JSON.parse(snapshot.text).version !== params.get('version')
      )
        return Response.json(
          {
            error:
              'This official transcript version is no longer available. Refresh to read the latest text.',
          },
          { status: 404, headers: { 'Cache-Control': 'no-store' } },
        );
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': fresh
          ? 'no-store'
          : snapshot.status === 200
            ? cacheControl
            : 'public, max-age=15, s-maxage=60',
        ...(snapshot.etag ? { ETag: snapshot.etag } : {}),
      };
      return new Response(
        etag === snapshot.etag && snapshot.status === 200
          ? null
          : snapshot.text,
        {
          status:
            etag === snapshot.etag && snapshot.status === 200
              ? 304
              : snapshot.status,
          headers,
        },
      );
    } catch {
      return Response.json(
        { error: 'YUTorah transcripts are temporarily unavailable.' },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' },
        },
      );
    }
  };
}

export const officialTranscript = createOfficialTranscriptReader({
  metadata: async (id) => {
    const { upstream, normalize } = await import('./yutorah');
    const raw = await upstream<import('./api-types').RawShiur>(
      `shiur/details?shiurID=${id}`,
      600,
    );
    if (String(raw.shiurID) !== id) throw new Error('Mismatched shiur.');
    const shiur = normalize(raw);
    return {
      title: shiur.title,
      teacher: shiur.teacher,
      mediaUrl: shiur.audio,
    };
  },
});
