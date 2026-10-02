import type { SearchDatabase } from './search-storage';
import {
  advanceSources,
  SourcesLimitError,
  type SourceTranscript,
} from './sources';
import { sourceText, type SefariaFetch } from './sefaria';

/** The same transcript reader and extraction path serve both tabs. No client-supplied prose or refs are trusted. */
export async function sourcesResponse(
  request: Request,
  dependencies: {
    db: SearchDatabase;
    transcript: (id: string) => Promise<Response>;
    fetcher?: SefariaFetch;
  },
  includeText = false,
) {
  const params = new URL(request.url).searchParams;
  const id = params.get('id') ?? '';
  const reply = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...(status === 202 ? { 'Retry-After': '2' } : {}),
      },
    });
  if (!/^[1-9]\d{0,11}$/.test(id))
    return reply({ error: 'Choose a valid shiur.' }, 400);
  try {
    const response = await dependencies.transcript(id);
    if (!response.ok)
      return reply(
        {
          error:
            response.status === 404
              ? 'A transcript has not been completed for this shiur yet.'
              : 'The transcript is temporarily unavailable.',
        },
        response.status,
      );
    const transcript = (await response.json()) as SourceTranscript;
    const result = await advanceSources(
      dependencies.db,
      transcript,
      dependencies.fetcher,
    );
    if (!includeText)
      return reply(result, result.status === 'pending' ? 202 : 200);
    const ref = params.get('ref');
    if (!ref || !result.sources.some((s) => s.ref === ref))
      return reply(
        { error: 'This source is not cited in this transcript.' },
        404,
      );
    return reply(await sourceText(ref, dependencies.fetcher));
  } catch (error) {
    return reply(
      {
        error:
          error instanceof SourcesLimitError
            ? error.message
            : 'Sources are temporarily unavailable. Please retry.',
      },
      error instanceof SourcesLimitError ? 413 : 503,
    );
  }
}
