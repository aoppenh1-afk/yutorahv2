import type { SearchResponse } from './api-types';

/** The API puts a multi-megabyte facet dictionary after `response`, even when
 * getFacets=false. Read the complete results object, then cancel the unused body.
 * Track JSON nesting and strings so braces and field names in titles are safe.
 */
export async function readTrendingResponse(
  response: Response,
): Promise<SearchResponse> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`YUTorah returned ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('YUTorah returned an empty body.');
  const decoder = new TextDecoder();
  let text = '',
    scanned = 0,
    depth = 0,
    quoted = false,
    escaped = false;
  let stringStart = 0,
    key = '',
    responseStart = -1,
    expectValue = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('YUTorah returned incomplete search JSON.');
      text += decoder.decode(value, { stream: true });
      for (; scanned < text.length; scanned++) {
        const c = text[scanned];
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') {
            quoted = false;
            if (depth === 1 && !expectValue)
              key = JSON.parse(text.slice(stringStart, scanned + 1));
          }
          continue;
        }
        if (c === '"') {
          quoted = true;
          stringStart = scanned;
        } else if (c === ':' && depth === 1) expectValue = true;
        else if (c === ',' && depth === 1) {
          expectValue = false;
          key = '';
        } else if (c === '{' || c === '[') {
          if (depth === 1 && expectValue && key === 'response') {
            if (c !== '{')
              throw new Error('YUTorah returned invalid search JSON.');
            responseStart = scanned;
          }
          depth++;
        } else if (c === '}' || c === ']') {
          depth--;
          if (responseStart >= 0 && depth === 1) {
            if (scanned > 2_000_000)
              throw new Error(
                'YUTorah search results exceeded the size limit.',
              );
            // Validate the prefix too, including fields preceding response.
            return {
              response: JSON.parse(text.slice(0, scanned + 1) + '}').response,
            };
          }
        }
      }
      if (text.length > 2_000_000)
        throw new Error('YUTorah search results exceeded the size limit.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readTrendingPage(
  page: number,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const query = new URLSearchParams({ start: String(page), searchTerm: '' });
  const response = await fetch(`https://api.yutorah.org/search/get?${query}`, {
    headers: { Accept: 'application/json' },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000),
  });
  return readTrendingResponse(response);
}
