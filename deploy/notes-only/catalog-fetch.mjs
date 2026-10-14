/** The fixed public catalog uses fetch so managed outbound networking can route it. */
export async function vmCatalogText(url, signal, maxBytes, fetcher = fetch) {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    target.hostname !== 'yutorah.org' ||
    target.pathname !== '/api/search/get' ||
    target.port ||
    target.username ||
    target.password
  )
    throw new Error('Invalid catalog endpoint.');
  const response = await fetcher(target.href, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Object.assign(new Error('Catalog request failed.'), {
      status: response.status,
      retryAfter: response.headers.get('Retry-After'),
    });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Catalog response is too large.');
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
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
