import {
  completeSearch,
  SearchChangedError,
  SearchBusyError,
} from '@/lib/complete-search';
import { searchDatabase } from '@/lib/search-db';
export async function GET(request: Request) {
  const started = performance.now();
  const p = new URL(request.url).searchParams;
  const number = (key: string, max = 1000000) =>
    Math.max(0, Math.min(max, Number(p.get(key)) || 0));
  const q = p.get('q') || '';
  const entityIds: Record<string, number[]> = {};
  for (const key of [
    'teacher',
    'series',
    'topic',
    'venue',
    'collection',
    'publication',
    'volume',
  ]) {
    const value = p.get(key);
    if (!value) continue;
    if (!/^[1-9]\d{0,5}(?:,[1-9]\d{0,5}){0,19}$/.test(value))
      return Response.json(
        { error: 'Choose valid library filters.' },
        { status: 400 },
      );
    entityIds[key] = [...new Set(value.split(',').map(Number))];
  }
  const entity = (key: string) => entityIds[key]?.[0] || 0;
  if (q.length > 300)
    return Response.json(
      { error: 'Please use a shorter search.' },
      { status: 400 },
    );
  const date = (key: string) => p.get(key) || '';
  for (const key of ['after', 'before', 'uploadedAfter', 'uploadedBefore']) {
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
    (date('uploadedAfter') &&
      date('uploadedBefore') &&
      date('uploadedAfter') > date('uploadedBefore')) ||
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
    const result = await completeSearch(
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
        uploadedAfter: date('uploadedAfter'),
        uploadedBefore: date('uploadedBefore'),
        phrase: p.get('phrase') || '',
        exclude: p.get('exclude') || '',
        scope: p.get('scope') === 'title' ? 'title' : '',
        literal: p.get('literal') === '1',
        resolved: p.get('resolved') === '1',
        language: ['EN', 'HE'].includes(p.get('language') || '')
          ? p.get('language')!
          : '',
        format: ['audio', 'video', 'text'].includes(p.get('format') || '')
          ? p.get('format')!
          : '',
        teacherId: entity('teacher'),
        seriesId: entity('series'),
        topicId: entity('topic'),
        venueId: entity('venue'),
        collectionId: entity('collection'),
        publicationId: entity('publication'),
        volumeId: entity('volume'),
        entityIds,
        group: (p.get('group') || '').slice(0, 100),
        dateBasis: p.get('dateBasis') === 'uploaded' ? 'uploaded' : 'given',
      },
      Math.max(1, Math.floor(number('page', 20000))),
      (p.get('run') || '').slice(0, 64),
    );
    const lifetime = Math.max(
      0,
      Math.floor(
        ((result.expiresAt || Date.now() + 60000) - Date.now()) / 1000,
      ),
    );
    const ttl = Math.min(60, lifetime);
    const stale = Math.min(120, Math.max(0, lifetime - ttl));
    return Response.json(result, {
      headers: {
        'Server-Timing': `search;dur=${(performance.now() - started).toFixed(1)}`,
        'Cache-Control': result.complete
          ? `public, max-age=${Math.min(30, ttl)}, s-maxage=${ttl}, stale-while-revalidate=${stale}`
          : 'no-store',
        ...(result.complete ? {} : { 'Retry-After': '2' }),
      },
    });
  } catch (e) {
    if (e instanceof SearchBusyError)
      return Response.json(
        { error: e.message },
        {
          status: 429,
          headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' },
        },
      );
    if (e instanceof RangeError || e instanceof SearchChangedError)
      return Response.json(
        { error: e.message },
        { status: e instanceof RangeError ? 400 : 409 },
      );
    console.error(JSON.stringify({ event: 'search_failed' }));
    return Response.json(
      { error: 'YUTorah search could not be reached. Please try again.' },
      { status: 502 },
    );
  }
}
