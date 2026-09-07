import { searchLibrary } from '@/lib/yutorah';
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
  try {
    return Response.json(
      await searchLibrary(
        q,
        {
          max: number('max', 240),
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
        Math.max(1, number('page', 20000)),
      ),
      { headers: { 'Cache-Control': 'public,max-age=60' } },
    );
  } catch {
    return Response.json(
      { error: 'YUTorah search could not be reached. Please try again.' },
      { status: 502 },
    );
  }
}
