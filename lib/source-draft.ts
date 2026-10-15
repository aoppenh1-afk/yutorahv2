import type { TranscriptSource } from './sources';
import type { SheetLanguage } from './source-sheet';
export type SourceDraft = {
  title: string;
  introduction: string;
  excluded: string[];
  order: string[];
  comments: Record<string, string>;
  manualRefs: string[];
  dismissed: string[];
  language: SheetLanguage;
  extent: 'excerpt' | 'full';
};
export function emptySourceDraft(title: string): SourceDraft {
  return {
    title,
    introduction: '',
    excluded: [],
    order: [],
    comments: {},
    manualRefs: [],
    dismissed: [],
    language: 'he',
    extent: 'excerpt',
  };
}
export function parseSourceDraft(
  raw: string | null,
  title: string,
): SourceDraft {
  const draft = emptySourceDraft(title);
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || typeof value !== 'object') return draft;
    for (const key of ['title', 'introduction'] as const)
      if (typeof value[key] === 'string')
        draft[key] = value[key].slice(0, key === 'title' ? 300 : 4000);
    for (const key of ['excluded', 'order', 'manualRefs', 'dismissed'] as const)
      if (Array.isArray(value[key]))
        draft[key] = [
          ...new Set<string>(
            value[key].filter(
              (s: unknown) => typeof s === 'string' && s.length <= 300,
            ),
          ),
        ].slice(0, key === 'manualRefs' ? 20 : 250);
    if (value.comments && typeof value.comments === 'object')
      draft.comments = Object.fromEntries(
        Object.entries(value.comments)
          .filter(([ref, text]) => ref.length < 250 && typeof text === 'string')
          .slice(0, 150)
          .map(([ref, text]) => [ref, (text as string).slice(0, 4000)]),
      );
    if (['both', 'he', 'en'].includes(value.language))
      draft.language = value.language;
    if (value.extent === 'full') draft.extent = 'full';
  } catch {
    /* A corrupted draft does not prevent opening the creator. */
  }
  return draft;
}
export function orderedSheetSources(
  sources: TranscriptSource[],
  draft: SourceDraft,
) {
  const order = new Map(draft.order.map((ref, index) => [ref, index]));
  return sources
    .filter((s) => !draft.excluded.includes(s.ref))
    .sort(
      (a, b) =>
        (order.get(a.ref) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.ref) ?? Number.MAX_SAFE_INTEGER),
    );
}

/** Preserve earlier edits while replacing the old automatic bilingual default. */
export function restoreSourceDraft(
  current: string | null,
  legacy: string | null,
  title: string,
) {
  if (current !== null) return parseSourceDraft(current, title);
  return { ...parseSourceDraft(legacy, title), language: 'he' as const };
}
