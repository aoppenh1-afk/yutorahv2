import { notesBundlePage } from '@/lib/notes-bundle';
import {
  SnapshotBusyError,
  SnapshotExpiredError,
} from '@/lib/public-snapshots';

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const kind = p.get('kind'),
    id = Number(p.get('id')),
    page = Number(p.get('page') || 1),
    version = p.get('version') || '';
  if (
    (kind !== 'collection' && kind !== 'series') ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    id > 1_000_000 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 2000 ||
    (version !== '' && !/^[a-f0-9]{64}$/.test(version))
  )
    return Response.json(
      { error: 'Choose a valid collection or series.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  try {
    const data = await notesBundlePage(kind, id, page, version);
    if (!data)
      return Response.json(
        { error: 'Notes are not available right now.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    return Response.json(data, {
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=900' },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof SnapshotExpiredError
            ? 'This collection has updated. Restart the notes download.'
            : 'Notes could not be gathered. Please try again.',
      },
      {
        status:
          error instanceof SnapshotExpiredError
            ? 409
            : error instanceof SnapshotBusyError
              ? 503
              : 502,
        headers: {
          'Cache-Control': 'no-store',
          ...(error instanceof SnapshotBusyError ? { 'Retry-After': '1' } : {}),
        },
      },
    );
  }
}
