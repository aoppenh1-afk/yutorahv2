import { transcriptGateway } from '@/lib/transcript-gateway';
import type { PublicContent } from '@/packages/transcription/src/public-content';

/** A complete plain-text view preserves browser find, copying and screen readers. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get('id') ?? '';
  if (!/^\d{1,12}$/.test(id))
    return Response.json({ error: 'Choose a valid shiur.' }, { status: 400 });
  const query = new URLSearchParams();
  const version = params.get('version');
  if (version && !/^[a-f0-9]{64}$/.test(version))
    return Response.json({ error: 'Invalid version.' }, { status: 400 });
  if (version) query.set('version', version);
  const response = await transcriptGateway(`/v1/transcripts/${id}`, query);
  if (!response.ok) return response;
  const content = (await response.json()) as PublicContent;
  const text =
    content.title +
    '\n' +
    content.teacher +
    '\n\n' +
    content.segments
      .map((s) => {
        const seconds = Math.floor(s.startMs / 1000);
        return `[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}] ${s.speaker ? s.speaker + ': ' : ''}${s.text}`;
      })
      .join('\n\n');
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="shiur-${id}.txt"`,
      'Cache-Control': response.headers.get('Cache-Control') ?? 'no-store',
    },
  });
}
