'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { NotesBundleKind } from '@/lib/notes-bundle';

type Status =
  | { phase: 'idle' }
  | { phase: 'gathering'; found: number; scanned?: number; total?: number }
  | { phase: 'building'; found: number }
  | { phase: 'done'; found: number }
  | { phase: 'error'; message: string };

export function useNotesBundle(
  kind: NotesBundleKind,
  id: number,
  name: string,
) {
  const [status, setStatus] = useState<Status>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    abort.current?.abort();
    setStatus({ phase: 'idle' });
  }, [kind, id]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (status.phase !== 'done') return;
    const timer = setTimeout(() => setStatus({ phase: 'idle' }), 8000);
    return () => clearTimeout(timer);
  }, [status]);
  const busy = status.phase === 'gathering' || status.phase === 'building';
  const start = async () => {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setStatus({ phase: 'gathering', found: 0 });
    try {
      const { downloadNotesBundle, NotesBundleEmpty } =
        await import('@/lib/notes-bundle-client');
      try {
        const found = await downloadNotesBundle({
          kind,
          id,
          name,
          signal: controller.signal,
          onProgress: (p) => {
            if (!controller.signal.aborted) setStatus(p);
          },
        });
        if (!controller.signal.aborted) setStatus({ phase: 'done', found });
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus({
          phase: 'error',
          message:
            error instanceof NotesBundleEmpty
              ? `None of the shiurim in this ${kind} have notes yet.`
              : 'The notes PDF could not be created. Please try again.',
        });
      }
    } catch {
      if (!controller.signal.aborted)
        setStatus({
          phase: 'error',
          message: 'The notes PDF could not be created. Please try again.',
        });
    }
  };
  const cancel = () => {
    abort.current?.abort();
    setStatus({ phase: 'idle' });
  };
  return { status, busy, start, cancel };
}

export function NotesBundleStatus({
  bundle,
}: {
  bundle: ReturnType<typeof useNotesBundle>;
}) {
  const { status } = bundle;
  if (status.phase === 'idle') return null;
  const found =
    'found' in status
      ? `${status.found.toLocaleString()} ${status.found === 1 ? 'shiur' : 'shiurim'}`
      : '';
  const text =
    status.phase === 'error'
      ? status.message
      : status.phase === 'done'
        ? `Downloaded notes for ${found}.`
        : status.phase === 'building'
          ? `Building one PDF from ${found}. Large sets can take a minute.`
          : status.total
            ? `Looking for notes… ${Math.round((100 * (status.scanned || 0)) / status.total)}% · ${status.found.toLocaleString()} found`
            : 'Looking for shiurim with notes…';
  return (
    <output
      className={
        'notes-bundle-status' + (status.phase === 'error' ? ' is-error' : '')
      }
      aria-live="polite"
    >
      {status.phase === 'done' ? (
        <Check size={15} />
      ) : status.phase !== 'error' ? (
        <Loader2 size={15} className="spin" />
      ) : null}
      <span>{text}</span>
      {bundle.busy ? (
        <button className="text-button" onClick={bundle.cancel}>
          Cancel
        </button>
      ) : status.phase === 'error' ? (
        <button className="text-button" onClick={() => void bundle.start()}>
          Try again
        </button>
      ) : null}
    </output>
  );
}
