import {
  performanceMetrics,
  dataAreas,
  dataSources,
  maxPerformanceBytes,
} from '@/lib/performance-report-schema';
import { maxOperationSamples, maxOperationMs } from '@/lib/performance-payload';

const allowed = new Set<string>(performanceMetrics);
const legacyTimings = new Set([
  'homeVisibleMs',
  'searchVisibleMs',
  'collectionVisibleMs',
  'shiurVisibleMs',
  'catalogVisibleMs',
]);
export async function POST(request: Request) {
  if (Number(request.headers.get('Content-Length') || 0) > maxPerformanceBytes)
    return new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxPerformanceBytes) {
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
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (
    !object(body) ||
    !['mobile', 'desktop'].includes(body.device as string) ||
    !object(body.metrics)
  )
    return new Response(null, { status: 400 });
  // Keep cached older clients readable, with their navigation proxy and summed
  // timings explicitly marked as version 1. Version 2 records operations.
  const legacy =
    body.operations === undefined &&
    ['warm', 'cold'].includes(body.cache as string);
  if (body.cache !== undefined && !legacy)
    return new Response(null, { status: 400 });
  const operations = body.operations === undefined ? [] : body.operations;
  if (
    !Array.isArray(operations) ||
    operations.length > maxOperationSamples ||
    operations.some(
      (operation) =>
        !object(operation) ||
        Object.keys(operation).length !== 4 ||
        !dataAreas.includes(operation.area as (typeof dataAreas)[number]) ||
        !['first', 'complete'].includes(operation.phase as string) ||
        !dataSources.includes(
          operation.source as (typeof dataSources)[number],
        ) ||
        typeof operation.ms !== 'number' ||
        !Number.isFinite(operation.ms) ||
        operation.ms < 0 ||
        operation.ms > maxOperationMs,
    )
  )
    return new Response(null, { status: 400 });
  const entries = Object.entries(body.metrics);
  if (
    (!entries.length && !operations.length) ||
    entries.length > allowed.size + (legacy ? legacyTimings.size : 0) ||
    entries.some(
      ([name, value]) =>
        (!allowed.has(name) && !(legacy && legacyTimings.has(name))) ||
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
      version: legacy ? 1 : 2,
      device: body.device,
      ...(legacy ? { navigationCache: body.cache } : { operations }),
      metrics: Object.fromEntries(entries),
    }),
  );
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  });
}
