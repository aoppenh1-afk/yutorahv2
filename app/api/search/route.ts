import { completeSearch, SearchChangedError } from '@/lib/complete-search';
import { searchDatabase } from '@/lib/search-db';
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const number = (key: string, max = 1000000) =>
    Math.max(0, Math.min(max, Number(p.get(key)) || 0));
  const q = p.get('q') || '';
  if (q.length > 300)
    return Response.json(
      { error: 'Please use a shorter search.' },
      { status: 400 },
    );
  const date = (key: string) => p.get(key) || '';
  for (const key of ['after', 'before']) {
    const value = date(key);
    if (
      value &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      return Response.json({ error: 'Choose a valid date.' }, { status: 400 });
  }
  if (
    (date('after') && date('before') && date('after') > date('before')) ||
    (number('min', 240) &&
      number('max', 240) &&
      number('min', 240) > number('max', 240))
  )
    return Response.json(
      { error: 'The start of a range must come before its end.' },
      { status: 400 },
    );
  if (['phrase', 'exclude'].some((key) => (p.get(key) || '').length > 300))
    return Response.json(
      { error: 'Please use fewer words in your filters.' },
      { status: 400 },
    );
  try {
    return Response.json(
      await completeSearch(
        searchDatabase(),
        q,
        {
          sort: [
            'relevance',
            'popular',
            'library',
            'new',
            'old',
            'short',
            'long',
            'title',
          ].includes(p.get('sort') || '')
            ? p.get('sort')!
            : '',
          max: number('max', 240),
          min: number('min', 240),
          after: date('after'),
          before: date('before'),
          phrase: p.get('phrase') || '',
          exclude: p.get('exclude') || '',
          scope: p.get('scope') === 'title' ? 'title' : '',
          language: ['EN', 'HE'].includes(p.get('language') || '')
            ? p.get('language')!
            : '',
          format: ['audio', 'video', 'text'].includes(p.get('format') || '')
            ? p.get('format')!
            : '',
          teacherId: number('teacher'),
          seriesId: number('series'),
          topicId: number('topic'),
        },
        Math.max(1, Math.floor(number('page', 20000))),
        (p.get('run') || '').slice(0, 64),
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof RangeError || e instanceof SearchChangedError)
      return Response.json(
        { error: e.message },
        { status: e instanceof RangeError ? 400 : 409 },
      );
    console.error('Search failed', e);
    return Response.json(
      { error: 'YUTorah search could not be reached. Please try again.' },
      { status: 502 },
    );
  }
}
