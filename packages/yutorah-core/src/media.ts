import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { Failure, checkAbort } from '../../antigravity-acp/src/errors.js';

const hosts = new Set([
  'yutorah.org',
  'www.yutorah.org',
  'classic.yutorah.org',
  'download.yutorah.org',
  'cdn.yutorah.org',
  'cdnyutorah.cachefly.net',
  'shiurim.yutorah.net',
  // Exact public bucket reached from YU Torah's own shiurim.yutorah.net redirect.
  'pub-118b5aaf6ae949ac8f59a93faec8a3da.r2.dev',
]);
export function mediaURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(
      value.replace(/&amp;/g, '&').replace(/-\.mp3(?=$|\?)/i, '.mp3'),
    );
  } catch {
    throw new Failure('download');
  }
  if (
    !hosts.has(url.hostname) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    throw new Failure('download');
  url.protocol = 'https:';
  url.hash = '';
  return url;
}
export function publicIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  return (
    p.length === 4 &&
    p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    ![0, 10, 127].includes(p[0]) &&
    p[0] < 224 &&
    !(p[0] === 169 && p[1] === 254) &&
    !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) &&
    !(p[0] === 192 && [0, 168].includes(p[1])) &&
    !(p[0] === 100 && p[1] >= 64 && p[1] <= 127) &&
    !(p[0] === 198 && [18, 19].includes(p[1]))
  );
}
async function response(
  raw: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<IncomingMessage> {
  checkAbort(signal);
  const url = mediaURL(raw);
  if (redirects > 5) throw new Failure('download');
  const { address } = await lookup(url.hostname, { family: 4 });
  if (!publicIPv4(address)) throw new Failure('download');
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        agent: false,
        headers: {
          'User-Agent': 'YUTorah-Transcription/0.1',
          'Accept-Encoding': 'identity',
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
      },
      resolve,
    );
    req.setTimeout(30_000, () => req.destroy(new Failure('download')));
    req.on('error', () => reject(new Failure('download')));
    req.end();
  });
  if (
    [301, 302, 303, 307, 308].includes(res.statusCode ?? 0) &&
    res.headers.location
  ) {
    const target = new URL(res.headers.location, url).href;
    res.destroy();
    return response(target, signal, redirects + 1);
  }
  if (res.statusCode !== 200) {
    res.destroy();
    throw new Failure('download');
  }
  return res;
}
async function boundedText(
  url: string,
  signal: AbortSignal,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const res = await response(
    url,
    AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of res) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      res.destroy();
      throw new Failure('download');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function resolveMedia(
  shiurId: string,
  supplied: string | null,
  signal: AbortSignal,
): Promise<string> {
  if (!/^\d{1,12}$/.test(shiurId)) throw new Failure('download');
  if (supplied) return mediaURL(supplied).href;
  try {
    const data = JSON.parse(
      await boundedText(
        `https://yutorah.org/api/shiur/details?shiurID=${shiurId}`,
        signal,
      ),
    ) as Record<string, unknown>;
    const candidate =
      data.downloadURL || data.shiurFileURL || data.shiurdownloadurl;
    if (typeof candidate === 'string' && candidate)
      return mediaURL(candidate).href;
  } catch {
    checkAbort(signal);
  }
  const html = await boundedText(
    `https://classic.yutorah.org/lectures/lecture_iframe.cfm/${shiurId}`,
    signal,
  );
  const candidate = html.match(
    /https?:\/\/[^"'<>\s]+\.mp3(?:\?[^"'<>\s]*)?/i,
  )?.[0];
  if (!candidate) throw new Failure('download');
  return mediaURL(candidate).href;
}

/** The public search endpoint pages thirty records in descending publication date. */
export async function catalogPage(
  page: number,
  signal: AbortSignal,
  selection?: {
    kind: 'teacher' | 'series';
    upstreamId: string;
    teacherId?: string;
  },
): Promise<{ total: number; docs: Record<string, unknown>[] }> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
    throw new Failure('configuration');
  const params = new URLSearchParams({
    searchTerm: '',
    getFacets: 'false',
    start: String(page),
  });
  if (selection) {
    if (
      !/^\d{1,12}$/.test(selection.upstreamId) ||
      !['teacher', 'series'].includes(selection.kind)
    )
      throw new Failure('configuration');
    params.set(
      selection.kind === 'teacher' ? 'teacherID' : 'seriesID',
      selection.upstreamId,
    );
    if (selection.teacherId) {
      if (
        selection.kind !== 'series' ||
        !/^\d{1,12}$/.test(selection.teacherId)
      )
        throw new Failure('configuration');
      params.set('teacherID', selection.teacherId);
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(
      await boundedText(
        `https://yutorah.org/api/search/get?${params}`,
        signal,
        8 * 1024 * 1024,
      ),
    );
  } catch {
    checkAbort(signal);
    throw new Failure('download');
  }
  const response = (
    data as { response?: { docs?: unknown; numFound?: unknown } }
  )?.response;
  if (
    !response ||
    !Number.isSafeInteger(response.numFound) ||
    !Array.isArray(response.docs) ||
    response.docs.length > 30 ||
    response.docs.some((item) => !item || typeof item !== 'object')
  )
    throw new Failure('download');
  return {
    total: response.numFound as number,
    docs: response.docs as Record<string, unknown>[],
  };
}

export async function catalogDirectory(signal: AbortSignal) {
  const read = async (kind: 'teachers' | 'series') => {
    const rows: unknown = JSON.parse(
      await boundedText(
        `https://yutorah.org/api/browse/${kind}`,
        signal,
        16 * 1024 * 1024,
      ),
    );
    if (!Array.isArray(rows) || rows.length > 100_000)
      throw new Failure('download');
    const plain = (v: unknown) =>
      (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
    return rows
      .filter(
        (r) =>
          r &&
          /^\d{1,12}$/.test(String(r.ID)) &&
          !r.isHidden &&
          Number(r.shiurCount) > 0,
      )
      .map((r) => ({
        id: String(r.ID),
        name: plain(
          kind === 'teachers'
            ? [r.title, r.firstName, r.lastName].filter(Boolean).join(' ')
            : r.name,
        ),
        count: Number(r.shiurCount),
      }))
      .sort((a, b) => b.count - a.count);
  };
  const [teachers, series] = await Promise.all([
    read('teachers'),
    read('series'),
  ]);
  return { teachers, series };
}

export async function homepageRecent(
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  let data: unknown;
  try {
    data = JSON.parse(
      await boundedText('https://yutorah.org/api/homepage/details', signal),
    );
  } catch {
    checkAbort(signal);
    throw new Failure('download');
  }
  const docs = (data as { recentlyUploaded?: unknown })?.recentlyUploaded;
  if (
    !Array.isArray(docs) ||
    docs.length > 100 ||
    docs.some((item) => !item || typeof item !== 'object')
  )
    throw new Failure('download');
  return docs as Record<string, unknown>[];
}
export async function downloadAudio(
  url: string,
  destination: string,
  signal: AbortSignal,
  maxBytes = 1024 * 1024 * 1024,
): Promise<void> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]);
  try {
    const res = await response(url, combined);
    if (
      /text\/|application\/json/i.test(res.headers['content-type'] ?? '') ||
      Number(res.headers['content-length'] ?? 0) > maxBytes
    ) {
      res.destroy();
      throw new Failure('download');
    }
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new Failure('download') : null, chunk);
      },
    });
    await pipeline(
      res,
      limit,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      { signal: combined },
    );
    if (!bytes) throw new Failure('download');
  } catch {
    await rm(destination, { force: true });
    checkAbort(signal);
    throw new Failure('download');
  }
}
