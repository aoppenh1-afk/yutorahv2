import { getCatalogService, deferCatalogWork } from '@/lib/catalog-server';
import { completeSearch } from '@/lib/complete-search';
import { searchDatabase } from '@/lib/search-db';
import type { SearchResult } from '@/lib/yutorah';

export async function GET(request: Request) {
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isSafeInteger(id) || id <= 0 || id > 1_000_000)
    return Response.json({ error: 'Choose a valid teacher.' }, { status: 400 });
  try {
    const service = await getCatalogService();
    const saved = await service.snapshots.peek<SearchResult>(
      'teacher-popular:' + id,
      60 * 60_000,
    );
    if (!saved)
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store' },
      });
    if (saved.stale)
      deferCatalogWork(async () => {
        const result = await completeSearch(searchDatabase(), '', {
          teacherId: id,
          sort: 'popular',
        });
        if (result.complete)
          await service.snapshots.save('teacher-popular:' + id, result);
      });
    return Response.json(
      { ...saved.value, preparedAt: saved.updated, stale: saved.stale },
      {
        headers: {
          'Cache-Control':
            'public,max-age=60,s-maxage=300,stale-while-revalidate=300',
        },
      },
    );
  } catch {
    return new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
