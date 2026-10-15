import type { SearchDatabase } from './search-storage';
import { advanceSourceCreator } from './source-creator';
import { sourceFeatures, type SourceFeatures } from './source-features';
import type { SourceInput } from './source-windows';
import { SourcesLimitError } from './sources';
import { pruneSourceCache } from './sources-cache';
import { SefariaUnavailableError, type SefariaFetch } from './sefaria';

export async function sourceCreatorResponse(
  request: Request,
  dependencies: {
    db: SearchDatabase;
    transcript: (id: string, params: URLSearchParams) => Promise<Response>;
    notes: (id: string) => Promise<Response>;
    features?: SourceFeatures;
    fetcher?: SefariaFetch;
  },
) {
  const features = dependencies.features || sourceFeatures();
  const reply = (body: unknown, status = 200, retry = 2000) =>
    Response.json(body, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...([202, 429, 503].includes(status) && retry > 0
          ? { 'Retry-After': String(Math.ceil(retry / 1000)) }
          : {}),
      },
    });
  if (!features.links && !features.sheets)
    return reply({ error: 'Source creation is turned off.' }, 404);
  const params = new URL(request.url).searchParams,
    id = params.get('id') || '';
  if (!/^[1-9]\d{0,11}$/.test(id))
    return reply({ error: 'Choose a valid shiur.' }, 400);
  if (params.get('source') && params.get('source') !== 'official-yutorah')
    return reply({ error: 'Choose a valid transcript source.' }, 400);
  if (params.get('version') && !/^[a-f0-9]{64}$/.test(params.get('version')!))
    return reply({ error: 'Choose a valid transcript version.' }, 400);
  try {
    const forwarded = new URLSearchParams();
    for (const key of ['source', 'version'])
      if (params.get(key)) forwarded.set(key, params.get(key)!);
    if (params.get('refresh') === '1') forwarded.set('fresh', 'true');
    const [transcriptResult, notesResult] = await Promise.allSettled([
      dependencies.transcript(id, forwarded),
      dependencies.notes(id),
    ]);
    const input: SourceInput = { shiurId: id, warnings: [] };
    if (
      params.get('revision') &&
      params.get('version') &&
      transcriptResult.status === 'fulfilled' &&
      transcriptResult.value.status === 404
    )
      return reply(
        {
          error:
            'This transcript version is no longer available. Refresh to check current sources.',
        },
        409,
      );
    if (transcriptResult.status === 'fulfilled' && transcriptResult.value.ok) {
      const data = await transcriptResult.value.json();
      if (
        typeof data.transcriptId === 'string' &&
        Array.isArray(data.segments)
      ) {
        if (
          params.get('revision') &&
          params.get('revision') !== data.transcriptId
        )
          return reply(
            {
              error:
                'The transcript has changed. Refresh to check the current sources.',
            },
            409,
          );
        input.transcript = {
          transcriptId: data.transcriptId,
          searchVersion: data.searchVersion,
          segments: data.segments.map(
            (s: { text: string; startMs: number; endMs: number }) => ({
              text: s.text,
              startMs: s.startMs,
              endMs: s.endMs,
            }),
          ),
          complete:
            data.complete !== false &&
            !['pending', 'streaming', 'transcribing'].includes(data.status),
        };
        if (data.notes?.markdown && data.notes.status === 'completed')
          input.notes = {
            markdown: data.notes.markdown,
            version: data.version,
          };
      }
    }
    if (!input.transcript)
      input.warnings!.push(
        'The transcript is unavailable. Only available notes are checked.',
      );
    if (notesResult.status === 'fulfilled' && notesResult.value.ok) {
      const data = await notesResult.value.json();
      if (
        data.status === 'completed' &&
        typeof data.markdown === 'string' &&
        data.markdown.trim()
      ) {
        // Match the notes currently displayed by the reader: archived embedded notes take priority.
        if (!input.notes || params.get('source') === 'official-yutorah')
          input.notes = {
            markdown: data.markdown,
            version: data.notesHash,
            sourceHash: data.sourceHash,
          };
        if (
          params.get('version') &&
          data.sourceHash &&
          data.sourceHash !== params.get('version')
        )
          input.warnings!.push(
            'The published notes use an earlier transcript version. Notes sources are labeled separately.',
          );
      }
    } else if (!input.notes)
      input.warnings!.push(
        'Published notes are temporarily unavailable. Transcript sources are still checked.',
      );
    if (!input.transcript && !input.notes) {
      const unavailable =
        transcriptResult.status === 'rejected' ||
        notesResult.status === 'rejected' ||
        (transcriptResult.status === 'fulfilled' &&
          transcriptResult.value.status >= 500) ||
        (notesResult.status === 'fulfilled' && notesResult.value.status >= 500);
      return reply(
        {
          error: unavailable
            ? 'The transcript and notes could not be loaded. Retry to continue.'
            : 'No transcript or published notes are available to check yet.',
        },
        unavailable ? 503 : 404,
      );
    }
    await pruneSourceCache(dependencies.db);
    const result = await advanceSourceCreator(
      dependencies.db,
      input,
      dependencies.fetcher,
    );
    return reply(
      result,
      result.status === 'pending' ? 202 : 200,
      result.waiting ? 2000 : 0,
    );
  } catch (error) {
    return reply(
      {
        error:
          error instanceof SourcesLimitError
            ? error.message
            : 'Source checking was interrupted. Retry to continue from the last saved step.',
      },
      error instanceof SourcesLimitError ? 413 : 503,
      error instanceof SefariaUnavailableError ? error.retryAfterMs : 2000,
    );
  }
}
