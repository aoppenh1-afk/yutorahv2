import type { SearchDatabase } from './search-storage';
import {
  advanceSources,
  cachedSourcesResult,
  type SourcesResult,
  SourcesLimitError,
  type SourceTranscript,
} from './sources';
import { SefariaUnavailableError, type SefariaFetch } from './sefaria';
import {
  cachedSourceText,
  sourceSnapshot,
  pruneSourceCache,
} from './sources-cache';

/** The same transcript reader and extraction path serve both tabs. No client-supplied prose or refs are trusted. */
export async function sourcesResponse(
  request: Request,
  dependencies: {
    db: SearchDatabase;
    transcript: (id: string, version?: string) => Promise<Response>;
    status?: (id: string) => Promise<Response>;
    fetcher?: SefariaFetch;
  },
  includeText = false,
) {
  const params = new URL(request.url).searchParams;
  const id = params.get('id') ?? '';
  const reply = (body: unknown, status = 200, retryMs = 2000) =>
    Response.json(body, {
      status,
      headers: {
        'Cache-Control':
          status === 200 ? 'public, max-age=60, s-maxage=300' : 'no-store',
        ...([202, 503].includes(status)
          ? { 'Retry-After': String(Math.ceil(retryMs / 1000)) }
          : {}),
      },
    });
  if (!/^[1-9]\d{0,11}$/.test(id))
    return reply({ error: 'Choose a valid shiur.' }, 400);
  try {
    let published:
      | { transcriptId: string; searchVersion?: string; version?: string }
      | undefined;
    if (dependencies.status) {
      const response = await dependencies.status(id);
      if (!response.ok) throw new TranscriptUnavailable(response.status);
      published = (await response.json()) as typeof published;
      if (
        (params.get('revision') &&
          params.get('revision') !== published?.transcriptId) ||
        (params.get('version') && params.get('version') !== published?.version)
      )
        return reply(
          {
            error:
              'The transcript has changed. Refresh the transcript to check its sources.',
          },
          409,
        );
      if (
        !published?.searchVersion ||
        !/^[a-f0-9]{64}$/.test(published.searchVersion)
      )
        published = undefined;
    }
    let result: SourcesResult | null = published?.searchVersion
      ? await cachedSourcesResult(
          dependencies.db,
          published.transcriptId,
          published.searchVersion,
        )
      : null;
    if (!result) {
      await pruneSourceCache(dependencies.db);
      const transcript = await sourceSnapshot(
        dependencies.db,
        id,
        async () => {
          const response = await dependencies.transcript(
            id,
            published?.version,
          );
          if (!response.ok) throw new TranscriptUnavailable(response.status);
          const data = (await response.json()) as SourceTranscript;
          if (published && data.transcriptId !== published.transcriptId)
            throw new TranscriptUnavailable(409);
          // Store only published text and timings, never notes or client-provided text.
          return {
            transcriptId: data.transcriptId,
            searchVersion: published?.searchVersion,
            segments: data.segments.map((s) => ({
              text: s.text,
              startMs: s.startMs,
              endMs: s.endMs,
            })),
          };
        },
        (published?.transcriptId || params.get('revision') || '') +
          ':' +
          (published?.searchVersion || ''),
        params.get('refresh') === '1',
      );
      if (
        params.get('revision') &&
        params.get('revision') !== transcript.transcriptId
      )
        return reply(
          {
            error:
              'The transcript has changed. Refresh the transcript to check its sources.',
          },
          409,
        );
      result = await advanceSources(
        dependencies.db,
        transcript,
        dependencies.fetcher,
      );
    }
    if (!includeText)
      return reply(result, result.status === 'pending' ? 202 : 200);
    const ref = params.get('ref');
    if (!ref || !result.sources.some((s) => s.ref === ref))
      return reply(
        { error: 'This source is not cited in this transcript.' },
        404,
      );
    const extent = params.get('extent') === 'full' ? 'full' : 'excerpt';
    return reply(
      await cachedSourceText(
        dependencies.db,
        ref,
        dependencies.fetcher,
        extent,
      ),
    );
  } catch (error) {
    if (error instanceof TranscriptUnavailable)
      return reply(
        {
          error:
            error.status === 404
              ? 'A transcript has not been completed for this shiur yet.'
              : 'The transcript is temporarily unavailable.',
        },
        error.status,
      );
    return reply(
      {
        error:
          error instanceof SourcesLimitError
            ? error.message
            : 'Sources are temporarily unavailable. Please retry.',
      },
      error instanceof SourcesLimitError ? 413 : 503,
      error instanceof SefariaUnavailableError ? error.retryAfterMs : 2000,
    );
  }
}
class TranscriptUnavailable extends Error {
  constructor(public status: number) {
    super('The transcript is temporarily unavailable.');
  }
}
