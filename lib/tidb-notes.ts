import { BoundedCache } from './bounded-cache';
import { TiDBNotesStore, unpackNote } from './tidb-notes-store';
type HostedNote = {
  markdown: string;
  sourceHash: string;
  notesHash: string;
  createdAtMs: number;
};
const cache = new BoundedCache<HostedNote | null>(64, 4 * 1024 * 1024);
const failures = new BoundedCache<boolean>(8, 2048);
const unavailable = () =>
  Response.json(
    { status: 'unavailable', markdown: null },
    {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
    },
  );
const pending = new Map<string, Promise<HostedNote | null>>();
export function notesCredential() {
  const credential = {
    host: process.env.TIDB_NOTES_HOST ?? '',
    username: process.env.TIDB_NOTES_USERNAME ?? '',
    password: process.env.TIDB_NOTES_PASSWORD ?? '',
    database: process.env.TIDB_NOTES_DATABASE ?? 'yutorah_notes',
  };
  return credential.host && credential.username && credential.password
    ? credential
    : null;
}
export async function hostedNotes(
  id: string,
  etag?: string,
): Promise<Response> {
  const credential = notesCredential();
  if (!credential)
    return Response.json(
      { status: 'not_configured', markdown: null },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  const databaseKey = `${credential.host}:${credential.username}:${credential.database}`;
  const key = `${databaseKey}:${id}`;
  const headers = {
    'Cache-Control':
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
  };
  const response = (value: HostedNote | null) => {
    if (!value)
      return Response.json(
        { status: 'missing', markdown: null },
        { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=60' } },
      );
    const tag = `"${value.notesHash}"`;
    return etag === tag
      ? new Response(null, { status: 304, headers: { ...headers, ETag: tag } })
      : Response.json(
          { status: 'completed', ...value },
          { headers: { ...headers, ETag: tag } },
        );
  };
  const cached = cache.get(key);
  if (cached !== undefined) return response(cached);
  if (failures.get(databaseKey)) return unavailable();
  const existing = pending.get(key);
  if (existing) return existing.then(response, unavailable);
  if (pending.size >= 8)
    return Response.json(
      { status: 'unavailable', markdown: null },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' },
      },
    );
  const task = (async () => {
    const note = await new TiDBNotesStore(credential).get(id);
    const value = note
      ? {
          markdown: await unpackNote(note),
          sourceHash: note.sourceHash,
          notesHash: note.notesHash,
          createdAtMs: note.createdAtMs,
        }
      : null;
    cache.set(key, value, note ? 3600_000 : 60_000);
    return value;
  })();
  pending.set(key, task);
  try {
    return response(await task);
  } catch {
    failures.set(databaseKey, true, 60_000);
    return unavailable();
  } finally {
    pending.delete(key);
  }
}
