import { env } from 'cloudflare:workers';
import { getCatalogService } from '@/lib/catalog-server';
import { transferAuthorized } from '@/lib/title-transfer';
import { catalogDirectory } from '@/lib/catalog';
import { completeSearch } from '@/lib/complete-search';
import { searchDatabase } from '@/lib/search-db';

const headers = { 'Cache-Control': 'no-store' };
/** Bounded jobs use the existing operator token; no public request can warm an arbitrary archive. */
export async function POST(request: Request) {
  const token = (env as unknown as { TRENDING_REFRESH_TOKEN?: string })
    .TRENDING_REFRESH_TOKEN;
  if (!(await transferAuthorized(request, token, !!token)))
    return Response.json({ error: 'Not found.' }, { status: 404, headers });
  const params = new URL(request.url).searchParams;
  const kind = params.get('kind') || 'plan';
  const id = Number(params.get('id'));
  try {
    const service = await getCatalogService();
    const db = searchDatabase();
    await db.prepare('SELECT resource FROM catalog_snapshots LIMIT 0').all();
    if (kind === 'plan') {
      const [collections, teachers, existing] = await Promise.all([
        catalogDirectory('collection', '', 0, true),
        catalogDirectory('teacher', '', 0, true),
        service.snapshots.resources(),
        service.home({ fresh: true }),
        service.directory({ fresh: true }),
      ]);
      for (const section of [
        'teacher',
        'series',
        'topic',
        'collection',
        'venue',
      ] as const)
        await service.browse(section, '', 0, { fresh: true });
      return Response.json(
        {
          collections: [
            ...new Set([
              ...existing
                .filter((e) => e.resource.startsWith('collection:'))
                .map((e) => Number(e.resource.split(':')[1])),
              ...collections.entries.map((e) => e.id),
            ]),
          ],
          teachers: [
            ...new Set([
              ...existing
                .filter((e) => e.resource.startsWith('teacher-popular:'))
                .map((e) => Number(e.resource.split(':')[1])),
              ...teachers.entries.map((e) => e.id),
            ]),
          ],
        },
        { headers },
      );
    }
    if (
      !['collection', 'teacher'].includes(kind) ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      id > 1_000_000
    )
      throw new RangeError('Choose a valid cache resource.');
    if (kind === 'collection') {
      const result = await service.collection(id, { fresh: true });
      const stored = await db
        .prepare(
          'SELECT updated FROM catalog_snapshots WHERE resource=? AND version=?',
        )
        .bind('collection:' + id, result.version)
        .first<{ updated: number }>();
      if (!stored || stored.updated < result.updated)
        throw new Error('The refreshed collection could not be persisted.');
      return Response.json(
        { complete: true, count: result.value.count },
        { headers },
      );
    }
    const result = await completeSearch(searchDatabase(), '', {
      teacherId: id,
      sort: 'popular',
    });
    if (result.complete)
      await service.snapshots.save('teacher-popular:' + id, result);
    return Response.json(
      {
        complete: result.complete,
        scanned: result.scanned,
        total: result.sourceTotal,
      },
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RangeError
            ? error.message
            : 'Cache refresh could not finish. Retry to resume.',
      },
      {
        status: error instanceof RangeError ? 400 : 503,
        headers: { ...headers, 'Retry-After': '5' },
      },
    );
  }
}
