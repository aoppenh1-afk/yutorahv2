'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptSource } from '@/lib/sources';
import type { SourceText } from '@/lib/sefaria';
import {
  emptySourceDraft,
  orderedSheetSources,
  restoreSourceDraft,
  type SourceDraft,
} from '@/lib/source-draft';
import {
  renderSourceSheet,
  sourceEditions,
  sourceSheetMarkdown,
  type SourceSheetOptions,
} from '@/lib/source-sheet';
import { sourceRequest } from '@/lib/source-request';
import { saveDownload } from '@/lib/save-download';

export type SheetFormat = 'pdf' | 'docx' | 'html' | 'print';
export function useSourceSheet(options: {
  shiurId: number;
  title: string;
  teacher: string;
  sources: TranscriptSource[];
  enabled: boolean;
  includeLinks: boolean;
  partial: boolean;
  limited: boolean;
}) {
  const { shiurId, title, teacher, enabled } = options;
  const [draft, setDraft] = useState<SourceDraft>(() =>
    emptySourceDraft(title),
  );
  const [restored, setRestored] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [manual, setManual] = useState<TranscriptSource[]>([]);
  const verifiedManual = useRef(new Map<string, TranscriptSource>());
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);
  const addingLock = useRef(false);
  const key = `yutorah:source-sheet:v2:${shiurId}`;
  useEffect(() => {
    try {
      setDraft(
        restoreSourceDraft(
          localStorage.getItem(key),
          localStorage.getItem(`yutorah:source-sheet:v1:${shiurId}`),
          title,
        ),
      );
    } catch {
      setStorageError(
        'Your changes will stay in this session. Download a copy to keep them.',
      );
    }
    setRestored(true);
  }, [key, shiurId, title]);
  useEffect(() => {
    if (!restored) return;
    try {
      localStorage.setItem(key, JSON.stringify(draft));
    } catch {
      setStorageError(
        'Your browser could not save this sheet. Download a copy to keep your changes.',
      );
    }
  }, [draft, restored, key]);
  const manualKey = draft.manualRefs.join('\0');
  useEffect(() => {
    if (!restored || !enabled) return;
    const abort = new AbortController();
    const refs = manualKey ? manualKey.split('\0') : [];
    const show = () =>
      setManual(refs.flatMap((ref) => verifiedManual.current.get(ref) || []));
    show();
    const queue = refs.filter((ref) => !verifiedManual.current.has(ref));
    const read = async () => {
      while (queue.length && !abort.signal.aborted) {
        const ref = queue.shift()!;
        try {
          const source = await verify(ref, abort.signal);
          if (!abort.signal.aborted) {
            verifiedManual.current.set(ref, source);
            show();
          }
        } catch {
          if (!abort.signal.aborted)
            setAddError(
              'An added source could not be loaded. Add it again to retry.',
            );
        }
      }
    };
    void Promise.all([read(), read(), read()]);
    return () => abort.abort();
  }, [manualKey, restored, enabled]);
  const sources = useMemo(() => {
    const combined = options.sources.map((source) => ({
      ...source,
      occurrences: [...source.occurrences],
    }));
    for (const source of manual) {
      const existing = combined.find((s) => s.ref === source.ref);
      if (existing) existing.occurrences.push(...source.occurrences);
      else combined.push(source);
    }
    return combined;
  }, [options.sources, manual]);
  const selected = useMemo(
    () => orderedSheetSources(sources, draft),
    [sources, draft],
  );
  const [cache, setCache] = useState<Record<string, SourceText>>({});
  const cacheRef = useRef(cache);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const refs = selected.map((s) => s.ref).join('\0'),
    extent = draft.extent;
  useEffect(() => {
    if (!enabled || !restored) return;
    const abort = new AbortController();
    const remaining = refs
      ? refs.split('\0').filter((ref) => !cacheRef.current[`${extent}:${ref}`])
      : [];
    setLoading(remaining.length > 0);
    const read = async () => {
      while (remaining.length && !abort.signal.aborted) {
        const ref = remaining.shift()!;
        try {
          const response = await sourceRequest(
            `/api/source-creator/text?extent=${extent}&ref=${encodeURIComponent(ref)}`,
            abort.signal,
          );
          const text = (await response.json()) as SourceText;
          if (text.ref !== ref) throw new Error('The source text has changed.');
          if (!abort.signal.aborted) {
            cacheRef.current = {
              ...cacheRef.current,
              [`${extent}:${ref}`]: text,
            };
            setCache(cacheRef.current);
          }
        } catch {
          /* Missing editions are disclosed in the sheet and download dialog. */
        }
      }
    };
    void Promise.all([read(), read(), read()]).then(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [refs, extent, enabled, restored, retry]);
  const texts = Object.fromEntries(
    selected.flatMap((s) =>
      cache[`${extent}:${s.ref}`] ? [[s.ref, cache[`${extent}:${s.ref}`]]] : [],
    ),
  );
  const missing = selected.filter(
    (source) => !sourceEditions(texts[source.ref], draft.language).length,
  ).length;
  const [busy, setBusy] = useState<SheetFormat | null>(null);
  const exportLock = useRef(false);
  const [exportError, setExportError] = useState('');
  const download = async (format: SheetFormat, allowMissing: boolean) => {
    if (
      loading ||
      !selected.length ||
      (missing && !allowMissing) ||
      exportLock.current
    )
      return false;
    exportLock.current = true;
    setBusy(format);
    setExportError('');
    try {
      const content: SourceSheetOptions = {
        shiurId,
        title: draft.title || title,
        teacher,
        origin: window.location.origin,
        sources: selected,
        texts,
        language: draft.language,
        extent,
        introduction: draft.introduction,
        comments: draft.comments,
        includeLinks: options.includeLinks,
        incomplete: options.partial,
        limited: options.limited,
      };
      if (format === 'print') printSheet(renderSourceSheet(content));
      else {
        const blob =
          format === 'html'
            ? new Blob([renderSourceSheet(content)], {
                type: 'text/html;charset=utf-8',
              })
            : format === 'pdf'
              ? await (
                  await import('@/lib/notes-pdf')
                ).createNotesPdf(sourceSheetMarkdown(content))
              : await (
                  await import('@/lib/notes-docx')
                ).createNotesDocx(sourceSheetMarkdown(content));
        saveDownload(blob, `shiur-${shiurId}-source-sheet.${format}`);
      }
      return true;
    } catch {
      setExportError('Could not prepare the sheet. Try again or choose HTML.');
      return false;
    } finally {
      exportLock.current = false;
      setBusy(null);
    }
  };
  const add = async (ref: string) => {
    if (addingLock.current || !ref.trim()) return false;
    addingLock.current = true;
    setAdding(true);
    setAddError('');
    try {
      const source = await verify(ref, AbortSignal.timeout(15000));
      if (
        draft.manualRefs.length >= 20 &&
        !draft.manualRefs.includes(source.ref)
      )
        throw new Error('Remove an added source before adding another.');
      verifiedManual.current.set(source.ref, source);
      setManual((previous) => [
        ...previous.filter((s) => s.ref !== source.ref),
        source,
      ]);
      setDraft((previous) => ({
        ...previous,
        manualRefs: [...new Set([...previous.manualRefs, source.ref])],
        excluded: previous.excluded.filter((s) => s !== source.ref),
      }));
      return true;
    } catch (failure) {
      setAddError(
        failure instanceof Error
          ? failure.message
          : 'Could not verify this source. Try again.',
      );
      return false;
    } finally {
      addingLock.current = false;
      setAdding(false);
    }
  };
  return {
    draft,
    setDraft,
    sources,
    selected,
    texts,
    loading,
    restored,
    missing,
    retryText: () => setRetry((n) => n + 1),
    storageError,
    addError,
    adding,
    add,
    busy,
    exportError,
    download,
  };
}
async function verify(
  ref: string,
  signal: AbortSignal,
): Promise<TranscriptSource> {
  const response = await fetch('/api/source-creator/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || 'Could not verify this source.');
  return data as TranscriptSource;
}
function printSheet(html: string) {
  const frame = document.createElement('iframe');
  frame.title = 'Print source sheet';
  frame.className = 'source-print-frame';
  const timeout = setTimeout(() => frame.remove(), 120000);
  frame.onload = () => {
    const target = frame.contentWindow;
    if (!target) {
      clearTimeout(timeout);
      frame.remove();
      return;
    }
    target.addEventListener(
      'afterprint',
      () => {
        clearTimeout(timeout);
        frame.remove();
      },
      { once: true },
    );
    try {
      target.focus();
      target.print();
    } catch {
      clearTimeout(timeout);
      frame.remove();
    }
  };
  frame.srcdoc = html;
  document.body.append(frame);
}
