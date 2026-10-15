import { searchDatabase } from '../../../lib/search-db';
import { searchNotes, NotesSearchError } from '../../../lib/notes-search';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const result = await searchNotes(searchDatabase(), params.get('q') || '', {
      mode: params.get('mode') === 'phrase' ? 'phrase' : 'terms',
      page: params.has('page') ? Number(params.get('page')) : 1,
      snapshot: params.get('snapshot') || '',
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status =
      error instanceof RangeError
        ? 400
        : error instanceof NotesSearchError
          ? error.status
          : 503;
    const message =
      error instanceof RangeError || error instanceof NotesSearchError
        ? error.message
        : 'Written notes search is temporarily unavailable. Please try again.';
    return Response.json(
      { error: message },
      {
        status,
        headers: {
          'Cache-Control': 'no-store',
          ...(status === 503 ? { 'Retry-After': '60' } : {}),
        },
      },
    );
  }
}
