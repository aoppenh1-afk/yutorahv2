/** The public reader needs timed segments and notes, not generation inputs. */
export type PublicContent = {
  id: string;
  title: string;
  teacher: string;
  mediaUrl?: string | null;
  transcriptId: string;
  durationMs: number;
  createdAt: string;
  version?: string;
  segments: Array<{
    startMs: number;
    endMs: number;
    text: string;
    speaker: string | null;
    language?: string | null;
  }>;
  notes: { status: string; markdown: string | null } | null;
};
export type ContentStatus = {
  searchVersion?: string;
  transcriptId: string;
  version?: string;
  notes: { status: string } | null;
};
export const contentCacheControl =
  'public, max-age=60, s-maxage=3600, stale-while-revalidate=300, stale-if-error=86400';
export const statusCacheControl = 'public, max-age=0, s-maxage=15';

export function pendingNotes(notes: { status: string } | null) {
  return !notes || ['queued', 'cleaning', 'generating'].includes(notes.status);
}

/** Reject malformed imports before they can replace a valid publication. */
export function validatePublicContent(
  value: unknown,
): asserts value is PublicContent {
  const c = value as PublicContent;
  if (
    !c ||
    !/^\d{1,12}$/.test(c.id) ||
    typeof c.title !== 'string' ||
    typeof c.teacher !== 'string' ||
    typeof c.transcriptId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(c.transcriptId) ||
    !Number.isSafeInteger(c.durationMs) ||
    c.durationMs <= 0 ||
    typeof c.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(c.createdAt)) ||
    !Array.isArray(c.segments) ||
    !c.segments.length ||
    c.segments.length > 5000 ||
    c.title.length > 2000 ||
    c.teacher.length > 1000 ||
    (c.mediaUrl != null &&
      (typeof c.mediaUrl !== 'string' || !/^https?:\/\//.test(c.mediaUrl))) ||
    (c.notes !== null &&
      (!c.notes ||
        ![
          'queued',
          'cleaning',
          'generating',
          'completed',
          'failed',
          'cancelled',
        ].includes(c.notes.status) ||
        (c.notes.markdown !== null && typeof c.notes.markdown !== 'string'))) ||
    c.segments.some(
      (s) =>
        !s ||
        !Number.isSafeInteger(s.startMs) ||
        !Number.isSafeInteger(s.endMs) ||
        s.startMs < 0 ||
        s.endMs < s.startMs ||
        s.endMs > c.durationMs + 1000 ||
        typeof s.text !== 'string' ||
        !s.text.trim() ||
        s.text.length > 64000 ||
        (s.speaker !== null && typeof s.speaker !== 'string') ||
        (s.language != null && typeof s.language !== 'string'),
    )
  )
    throw new Error('Invalid published transcript.');
}

/** Explicit field selection keeps checkpoints and cleaned model inputs private. */
export function publicContent(c: PublicContent): PublicContent {
  validatePublicContent(c);
  return {
    id: c.id,
    title: c.title,
    teacher: c.teacher,
    mediaUrl: c.mediaUrl ?? null,
    transcriptId: c.transcriptId,
    durationMs: c.durationMs,
    createdAt: new Date(c.createdAt).toISOString(),
    segments: c.segments.map((s) => ({
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      speaker: s.speaker,
      language: s.language ?? null,
    })),
    notes: c.notes && { status: c.notes.status, markdown: c.notes.markdown },
  };
}
