'use client';
import { useEffect, useState } from 'react';
import {
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Printer,
} from 'lucide-react';
import { timeLabel } from '@/lib/library';
import type { SourcesResult, TranscriptSource } from '@/lib/sources';
import type { SourceText } from '@/lib/sefaria';
import { renderSourceSheet } from '@/lib/source-sheet';

export function useTranscriptSources(
  shiurId: number,
  transcriptId: string | undefined,
  enabled: boolean,
) {
  const [result, setResult] = useState<SourcesResult | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setResult(null);
    setError('');
    if (!enabled || !transcriptId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const read = async () => {
      try {
        const response = await fetch(`/api/sources?id=${shiurId}`, {
          signal: abort.signal,
        });
        const data = (await response.json()) as SourcesResult & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || 'Sources are temporarily unavailable.');
        if (data.transcriptId !== transcriptId)
          throw new Error(
            'The transcript has changed. Refresh the transcript to check its sources.',
          );
        if (abort.signal.aborted) return;
        setResult(data);
        if (data.status === 'pending') {
          if (++polls >= 300)
            throw new Error(
              'Sources are still being checked. Retry to continue.',
            );
          timer = setTimeout(() => void read(), 2000);
        }
      } catch (error) {
        if (!abort.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : 'Sources are temporarily unavailable.',
          );
      }
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [shiurId, transcriptId, enabled, retry]);
  return { result, error, retry: () => setRetry((n) => n + 1) };
}

export function SourcesPanel({
  shiurId,
  title,
  teacher,
  result,
  error,
  onRetry,
  onSeek,
}: {
  shiurId: number;
  title: string;
  teacher: string;
  result: SourcesResult | null;
  error: string;
  onRetry: () => void;
  onSeek: (seconds: number) => void;
}) {
  const [sheet, setSheet] = useState(false);
  return (
    <div className="study-sources">
      <p className="study-note-label">
        Explicit transcript citations linked through Sefaria. Incomplete,
        ambiguous, and context-filled references are omitted. Timestamps mark
        the start of the transcript segment.
      </p>
      {error ? (
        <output className="study-state">
          {error}{' '}
          <button type="button" onClick={onRetry}>
            Retry sources
          </button>
        </output>
      ) : (
        (!result || result.status === 'pending') && (
          <output className="feed-loading">
            <Loader2 size={14} className="spin" /> Checking cited sources with
            Sefaria…{result ? ` ${result.progress}%` : ''}
          </output>
        )
      )}
      {result?.sources.length ? (
        <>
          <ol className="sources-list" aria-label="Cited sources">
            {result.sources.map((source) => (
              <li key={source.ref}>
                <div className="source-citation">
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.ref}
                    <ExternalLink size={13} />
                  </a>
                  <span className="source-category">{source.category}</span>
                </div>
                <p className="source-mention" dir="auto">
                  “{source.occurrences[0].mention}”
                </p>
                <div className="source-times">
                  {Array.from(
                    new Set(source.occurrences.map((o) => o.startMs)),
                  ).map((ms) => (
                    <button
                      className="study-time"
                      type="button"
                      key={ms}
                      onClick={() => onSeek(ms / 1000)}
                      aria-label={`Play ${source.ref} from ${timeLabel(ms / 1000)}`}
                    >
                      {timeLabel(ms / 1000)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          {result.status === 'ready' && (
            <button
              className="source-sheet-toggle"
              type="button"
              aria-expanded={sheet}
              onClick={() => setSheet((value) => !value)}
            >
              <FileText size={15} />
              {sheet ? 'Hide source sheet preview' : 'Preview source sheet'}
            </button>
          )}
        </>
      ) : (
        result?.status === 'ready' && (
          <p className="study-state">
            No complete, unambiguous citations were found. A source may have
            been mentioned without enough detail, or Sefaria may not have
            recognized it.
          </p>
        )
      )}
      {result?.limited && (
        <p className="study-state">
          Showing the first 100 sources. This list is incomplete.
        </p>
      )}
      {!!result?.omitted && (
        <p className="study-note-label">
          Some detected references were omitted because they could not be linked
          safely.
        </p>
      )}
      {sheet && result?.status === 'ready' && (
        <SourceSheetPreview
          shiurId={shiurId}
          title={title}
          teacher={teacher}
          sources={result.sources}
          limited={result.limited}
        />
      )}
      <p className="sefaria-credit">
        <a href="https://www.sefaria.org" target="_blank" rel="noreferrer">
          Powered by Sefaria
        </a>
      </p>
    </div>
  );
}

function SourceSheetPreview({
  shiurId,
  title,
  teacher,
  sources,
  limited,
}: {
  shiurId: number;
  title: string;
  teacher: string;
  sources: TranscriptSource[];
  limited: boolean;
}) {
  const [texts, setTexts] = useState<Record<string, SourceText>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const refs = sources.map((s) => s.ref).join('\0');
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setFailed(false);
    setTexts({});
    const remaining = refs.split('\0');
    const read = async () => {
      while (remaining.length && !abort.signal.aborted) {
        const ref = remaining.shift()!;
        try {
          const response = await fetch(
            `/api/source-text?id=${shiurId}&ref=${encodeURIComponent(ref)}`,
            { signal: abort.signal },
          );
          if (!response.ok) throw new Error('Text unavailable');
          const text = (await response.json()) as SourceText;
          if (text.ref !== ref) throw new Error('Different source');
          if (!abort.signal.aborted)
            setTexts((old) => ({ ...old, [ref]: text }));
        } catch {
          if (!abort.signal.aborted) setFailed(true);
        }
      }
    };
    void Promise.all([read(), read(), read()]).then(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [shiurId, refs, retry]);
  const documentHtml = () =>
    renderSourceSheet({
      shiurId,
      title,
      teacher,
      origin: window.location.origin,
      sources,
      texts,
      limited,
    });
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([documentHtml()], { type: 'text/html;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `shiur-${shiurId}-source-sheet.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const print = () => {
    const frame = document.createElement('iframe');
    frame.title = 'Print source sheet';
    frame.className = 'source-print-frame';
    frame.onload = () => {
      const target = frame.contentWindow;
      if (!target) {
        frame.remove();
        return;
      }
      target.addEventListener('afterprint', () => frame.remove(), {
        once: true,
      });
      target.focus();
      target.print();
    };
    frame.srcdoc = documentHtml();
    document.body.append(frame);
  };
  return (
    <section className="source-sheet-preview" aria-label="Source sheet preview">
      <div className="source-sheet-tools">
        <span>Source sheet preview</span>
        <button type="button" disabled={loading} onClick={download}>
          <Download size={14} />
          Download sheet
        </button>
        <button type="button" disabled={loading} onClick={print}>
          <Printer size={14} />
          Print / Save PDF
        </button>
      </div>
      <header>
        <p className="source-sheet-eyebrow">YUTorah Study · Cited sources</p>
        <h4>{title}</h4>
        <p>{teacher}</p>
        <p className="study-note-label">
          Automatically assembled from explicit transcript citations. Check
          against the recording.
        </p>
      </header>
      {loading && (
        <output className="feed-loading">
          <Loader2 size={14} className="spin" />
          Loading source text from Sefaria…
        </output>
      )}
      {failed && (
        <output className="study-state">
          Some source text is unavailable. Its citation links remain in the
          sheet.{' '}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Retry source text
          </button>
        </output>
      )}
      {sources.map((source, index) => (
        <article key={source.ref}>
          <p className="source-sheet-eyebrow">
            {index + 1} ·{' '}
            {texts[source.ref]?.categories.join(' / ') || source.category}
          </p>
          <h5>
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.ref}
              <ExternalLink size={13} />
            </a>
          </h5>
          <p className="source-he-ref" dir="rtl">
            {source.heRef}
          </p>
          <p className="study-note-label">
            Mentioned at{' '}
            {Array.from(
              new Set(
                source.occurrences.map((o) => timeLabel(o.startMs / 1000)),
              ),
            ).join(', ')}
          </p>
          {texts[source.ref]?.editions.map((edition, i) => (
            <div key={edition.title + i}>
              <div className="source-edition-text" dir={edition.direction}>
                {edition.text.map((line, j) => (
                  <p key={j}>{line}</p>
                ))}
              </div>
              {edition.truncated && (
                <p className="study-note-label">
                  Excerpt; open Sefaria for the complete cited text.
                </p>
              )}
              <p className="source-attribution">
                {edition.title} · {edition.language} · {edition.license}
                {edition.versionSource && (
                  <>
                    {' '}
                    ·{' '}
                    <a
                      href={edition.versionSource}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Edition source
                    </a>
                  </>
                )}{' '}
                ·{' '}
                <a href={source.url} target="_blank" rel="noreferrer">
                  Sefaria
                </a>
              </p>
            </div>
          ))}
          {!loading && !texts[source.ref]?.editions.length && (
            <p className="study-state">
              Source text is unavailable. Read this source on Sefaria.
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
