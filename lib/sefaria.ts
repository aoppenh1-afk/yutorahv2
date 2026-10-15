/** Server-only access to Sefaria. References and URLs always come from its APIs. */
const origin = 'https://www.sefaria.org';
export class SefariaTaskError extends Error {}
export class SefariaUnavailableError extends Error {
  constructor(public retryAfterMs = 2000) {
    super('Sefaria is temporarily unavailable.');
  }
}
export type SefariaFetch = typeof fetch;
export type LinkerDebug = {
  context_ref: string | null;
  context_type: string | null;
  resolved_part_classes: string[];
  orig_part_types: string[];
};
export type LinkerBody = {
  results: Array<{
    startChar: number;
    endChar: number;
    text: string;
    linkFailed: boolean;
    refs: string[] | null;
  }>;
  refData: Record<
    string,
    { heRef: string; url: string; primaryCategory: string }
  >;
  debugData: LinkerDebug[][];
};
export type RefMetadata = {
  is_ref: boolean;
  normalized: string;
  hebrew: string;
  url_ref: string;
  node_type: string;
  depth: number;
  address_types: string[];
  start_indexes: number[];
  end_indexes: number[];
  start_labels: string[];
  end_labels: string[];
};
export type SourceEdition = {
  language: string;
  direction: 'rtl' | 'ltr';
  title: string;
  license: string;
  versionSource: string | null;
  text: string[];
  truncated: boolean;
};
export type SourceText = {
  ref: string;
  categories: string[];
  editions: SourceEdition[];
};
export type SourceVersion = { language: 'english' | 'hebrew'; title: string };

async function request(
  path: string,
  fetcher: SefariaFetch,
  init?: RequestInit,
  allowInvalidRef = false,
) {
  const response = await fetcher(origin + path, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (allowInvalidRef && response.status === 404)
    return { status: 404, data: { is_ref: false } };
  if (!response.ok) {
    const retry = response.headers.get('Retry-After');
    const delay =
      retry && /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : retry
          ? Date.parse(retry) - Date.now()
          : 2000;
    throw new SefariaUnavailableError(
      Math.min(60000, Math.max(2000, Number.isFinite(delay) ? delay : 2000)),
    );
  }
  // Bound the download before parsing; truncating editions alone does not bound an upstream response.
  const reader = response.body?.getReader();
  let json = '';
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4_000_000) {
          await reader.cancel();
          throw new Error('Sefaria returned too much data for this source.');
        }
        json += decoder.decode(value, { stream: true });
      }
      json += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  const data = JSON.parse(json);
  if (data?.state === 'FAILURE')
    throw new SefariaTaskError('Sefaria could not process this transcript.');
  if (!data || typeof data !== 'object' || data.error)
    throw new Error('Sefaria returned an unsuccessful response.');
  return { status: response.status, data };
}

/** Handle both the current async response and older synchronous deployments. */
export async function findRefs(
  body: string,
  fetcher: SefariaFetch,
  language: 'en' | 'he',
) {
  const { data } = await request(
    '/api/find-refs?debug=1&with_text=0',
    fetcher,
    {
      method: 'POST',
      body: JSON.stringify({ text: { title: '', body }, lang: language }),
    },
  );
  if (typeof data.task_id === 'string' && !data.body && !data.result) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(data.task_id))
      throw new Error('Sefaria returned an invalid task.');
    return { taskId: data.task_id as string, body: null };
  }
  return { taskId: null, body: linkerBody(data.result ?? data) };
}

export async function pollRefs(taskId: string, fetcher: SefariaFetch) {
  const { data } = await request(
    `/api/async/${encodeURIComponent(taskId)}`,
    fetcher,
  );
  if (data.state === 'FAILURE')
    throw new SefariaTaskError('Sefaria could not process this transcript.');
  if (
    data.ready === false ||
    ['PENDING', 'RECEIVED', 'STARTED', 'RETRY'].includes(data.state)
  )
    return null;
  return linkerBody(data.result ?? data);
}

function linkerBody(value: { body?: LinkerBody }): LinkerBody {
  const body = value?.body;
  if (
    !body ||
    !Array.isArray(body.results) ||
    !body.refData ||
    !Array.isArray(body.debugData)
  )
    throw new Error('Sefaria returned an unsupported reference response.');
  return body;
}

export async function refMetadata(
  ref: string,
  fetcher: SefariaFetch,
): Promise<RefMetadata | null> {
  const { data } = await request(
    `/api/ref/${encodeURIComponent(ref)}`,
    fetcher,
    undefined,
    true,
  );
  if (data.is_ref === false) return null;
  if (data.is_ref === true && data.node_type !== 'JaggedArrayNode') return null;
  if (
    data.is_ref !== true ||
    typeof data.normalized !== 'string' ||
    typeof data.hebrew !== 'string' ||
    typeof data.url_ref !== 'string' ||
    !Array.isArray(data.start_indexes) ||
    !Array.isArray(data.end_indexes) ||
    !Array.isArray(data.address_types) ||
    !Array.isArray(data.start_labels) ||
    !Array.isArray(data.end_labels) ||
    !Number.isInteger(data.depth) ||
    data.depth < 1 ||
    data.depth > 10 ||
    [data.start_indexes, data.end_indexes].some((values) =>
      values.some((n: unknown) => !Number.isSafeInteger(n) || Number(n) < 0),
    ) ||
    [data.address_types, data.start_labels, data.end_labels].some((values) =>
      values.some((s: unknown) => typeof s !== 'string'),
    )
  )
    throw new Error('Sefaria returned unsupported reference metadata.');
  // Persist only validation fields, not arbitrary additional upstream payload.
  return {
    is_ref: true,
    normalized: data.normalized,
    hebrew: data.hebrew,
    url_ref: data.url_ref,
    node_type: data.node_type,
    depth: data.depth,
    address_types: data.address_types,
    start_indexes: data.start_indexes,
    end_indexes: data.end_indexes,
    start_labels: data.start_labels,
    end_labels: data.end_labels,
  };
}

export function sefariaUrl(path: string): string | null {
  // The API supplies a relative ref URL, never an arbitrary external link.
  if (
    !path ||
    /[\\?#\s]/u.test(path) ||
    path.startsWith('/') ||
    path.includes('://')
  )
    return null;
  const url = new URL('/' + path, origin);
  return url.origin === origin && url.pathname !== '/' ? url.href : null;
}

function publicUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Exact library search shares the bounded reader, timeout, and Retry-After handling. */
export async function searchPassage(
  query: string,
  fetcher: SefariaFetch = fetch,
) {
  const { data } = await request('/api/search/text/_search', fetcher, {
    method: 'POST',
    body: JSON.stringify({
      size: 60,
      track_total_hits: true,
      _source: ['ref', 'heRef', 'exact', 'path', 'lang', 'version'],
      query: { match_phrase: { exact: { query, slop: 0 } } },
    }),
  });
  return data;
}

/** Apply the same excerpt limits to cached full texts and fresh responses. */
export function sourceTextExcerpt(text: SourceText): SourceText {
  return {
    ...text,
    editions: text.editions.map((edition) => {
      const lines: string[] = [];
      let characters = 0;
      let truncated = edition.truncated;
      for (const line of edition.text) {
        if (lines.length >= 8 || characters >= 12000) {
          truncated = true;
          break;
        }
        const room = 12000 - characters;
        lines.push(line.slice(0, room));
        characters += Math.min(line.length, room);
        if (line.length > room) truncated = true;
      }
      return { ...edition, text: lines, truncated };
    }),
  };
}

/** Text retrieval is separate from citation extraction. */
export async function sourceText(
  ref: string,
  fetcher: SefariaFetch = fetch,
  extent: 'excerpt' | 'full' = 'excerpt',
  version?: SourceVersion,
): Promise<SourceText> {
  const selection = version
    ? `version=${encodeURIComponent(`${version.language}|${version.title}`)}`
    : 'version=primary&version=english';
  const { data } = await request(
    `/api/v3/texts/${encodeURIComponent(ref)}?${selection}&fill_in_missing_segments=0&return_format=text_only`,
    fetcher,
  );
  // v3 can silently expand a broad ref to its first section. Never accept that.
  if (
    data.ref !== ref ||
    !Array.isArray(data.versions) ||
    !Array.isArray(data.categories)
  )
    throw new Error('Sefaria returned text for a different reference.');
  const editions: SourceEdition[] = [];
  for (const version of data.versions) {
    if (
      !version ||
      typeof version.versionTitle !== 'string' ||
      typeof version.language !== 'string'
    )
      continue;
    const lines: string[] = [];
    let truncated = false;
    let characters = 0;
    const collect = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (typeof value !== 'string' || !value.trim()) return;
      const maxLines = extent === 'full' ? 500 : 8;
      const maxCharacters = extent === 'full' ? 200000 : 12000;
      if (lines.length >= maxLines || characters >= maxCharacters) {
        truncated = true;
        return;
      }
      // React and the sheet exporter escape this text; no upstream HTML is executed.
      const plain = value.replace(/<[^>]*>/g, '').trim();
      const room = maxCharacters - characters;
      if (plain.length > room) truncated = true;
      lines.push(plain.slice(0, room));
      characters += Math.min(plain.length, room);
    };
    collect(version.text);
    if (!lines.length) continue;
    editions.push({
      language: version.actualLanguage || version.language,
      direction: version.direction === 'rtl' ? 'rtl' : 'ltr',
      title: version.versionTitle,
      license:
        typeof version.license === 'string'
          ? version.license
          : 'License not supplied',
      versionSource: publicUrl(version.versionSource),
      text: lines,
      truncated,
    });
  }
  return {
    ref,
    categories: data.categories.filter((c: unknown) => typeof c === 'string'),
    editions,
  };
}
