import { Pool } from 'pg';
import { TranscriptionStore } from '../../../packages/transcription/src/store';
import { contentHash } from '../../../packages/transcription/src/archive';
import { publicContent } from '../../../packages/transcription/src/public-content';

let pool: Pool | undefined;
/** Temporary, authenticated migration access through the existing deployment.
 * Removing TRANSCRIPT_EXPORT_TOKEN disables this route, including its manifest.
 */
export async function GET(request: Request) {
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const token = process.env.TRANSCRIPT_EXPORT_TOKEN;
  if (!token || token.length < 32) return reply({ error: 'Not found' }, 404);
  const given = request.headers.get('Authorization') ?? '';
  if (
    !given.startsWith('Bearer ') ||
    (await contentHash(given.slice(7))) !== (await contentHash(token))
  )
    return reply({ error: 'Unauthorized' }, 401);
  if (!process.env.TRANSCRIPT_DATABASE_URL)
    return reply({ error: 'Source is not configured' }, 503);
  try {
    pool ??= new Pool({
      connectionString: process.env.TRANSCRIPT_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 8000,
      query_timeout: 30000,
      idleTimeoutMillis: 10000,
      allowExitOnIdle: true,
    });
    const params = new URL(request.url).searchParams;
    if (params.get('manifest') === 'true') {
      const result = await pool.query<{ id: string; transcriptId: string }>(
        'SELECT id,active_transcript_id AS "transcriptId" FROM transcription_shiurim WHERE active_transcript_id IS NOT NULL ORDER BY id',
      );
      return reply({ items: result.rows });
    }
    const id = params.get('id') ?? '';
    if (!/^\d{1,12}$/.test(id)) return reply({ error: 'Invalid shiur' }, 400);
    const content = await new TranscriptionStore(pool).publicContent(id);
    if (!content) return reply({ error: 'No transcript' }, 404);
    if (
      params.get('transcriptId') &&
      params.get('transcriptId') !== content.transcriptId
    )
      return reply({ error: 'Source changed. Export a new manifest.' }, 409);
    const exported = publicContent(content);
    return reply({
      content: exported,
      hash: await contentHash(JSON.stringify(exported)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason =
      /quota|allowance|network.*limit|transfer.*limit|usage.*limit|usage.*exceed/i.test(
        message,
      )
        ? 'free_quota_exhausted'
        : /password|authentication/i.test(message)
          ? 'authentication_failed'
          : /does not exist|permission denied/i.test(message)
            ? 'schema_or_permissions'
            : 'connection_unavailable';
    return reply(
      { error: 'Source database is temporarily unavailable', reason },
      503,
    );
  }
}
