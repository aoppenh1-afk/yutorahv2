const allowed = new Set([
  'LCP',
  'INP',
  'CLS',
  'longTasks',
  'longTaskMs',
  'viewCommits',
  'viewCommitMs',
  'maxVisibleRows',
  'libraryWrites',
  'libraryWriteMs',
]);
export async function POST(request: Request) {
  if (Number(request.headers.get('Content-Length') || 0) > 2048)
    return new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2048) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  let body: {
    device?: string;
    cache?: string;
    metrics?: Record<string, unknown>;
  };
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (
    !body ||
    !['mobile', 'desktop'].includes(body.device ?? '') ||
    !['warm', 'cold'].includes(body.cache ?? '') ||
    !body.metrics ||
    typeof body.metrics !== 'object'
  )
    return new Response(null, { status: 400 });
  const entries = Object.entries(body.metrics);
  if (
    !entries.length ||
    entries.length > allowed.size ||
    entries.some(
      ([name, value]) =>
        !allowed.has(name) ||
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1e8,
    )
  )
    return new Response(null, { status: 400 });
  console.log(
    JSON.stringify({
      event: 'frontend_performance',
      device: body.device,
      cache: body.cache,
      metrics: Object.fromEntries(entries),
    }),
  );
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  });
}
