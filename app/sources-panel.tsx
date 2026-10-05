'use client';
import { pollDelay } from '@/lib/poll-delay';
import { useEffect, useRef, useState } from 'react';
import {
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Printer,
} from 'lucide-react';
import { timeLabel } from '@/lib/library';
import type {
  SourcesResult,
  TranscriptSource,
  OmissionReason,
} from '@/lib/sources';
import type { SourceText } from '@/lib/sefaria';
import {
  renderSourceSheet,
  sourceEditions,
  type SheetLanguage,
} from '@/lib/source-sheet';
import { sourceRequest, sourceRetryDelay } from '@/lib/source-request';
const omissionLabels: Record<OmissionReason, string> = {
  unresolved: 'Not resolved by Sefaria',
  ambiguous: 'Ambiguous reference',
  inferred: 'Requires an inferred location',
  missing_location: 'Missing a complete location',
  missing_amud: 'Missing an explicit amud',
  missing_comment: 'Missing an individual comment',
  incomplete_range: 'Incomplete range endpoints',
  partial_commentary: 'Only part of a commentary citation was recognized',
  invalid_match: 'Citation could not be verified',
  limit: 'Sources limit reached',
};

export function useTranscriptSources(
  shiurId: number,
  transcriptId: string | undefined,
  enabled: boolean,
) {
  const [result, setResult] = useState<SourcesResult | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    setResult(null);
    setError('');
    setRecovering(false);
    if (!enabled || !transcriptId) return;
    const abort = new AbortController();
    let polls = 0;
    const read = async () => {
      try {
        const response = await sourceRequest(
          `/api/sources?id=${shiurId}&revision=${encodeURIComponent(transcriptId)}`,
          abort.signal,
          {
            onRetry: () => {
              if (!abort.signal.aborted) setRecovering(true);
            },
          },
        );
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
        setRecovering(false);
        if (data.status === 'pending') {
          if (++polls >= 300)
            throw new Error(
              'Sources are still being checked. Retry to continue.',
            );
          await pollDelay(
            sourceRetryDelay(response.headers.get('Retry-After')),
            abort.signal,
          );
          if (!abort.signal.aborted) void read();
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
    };
  }, [shiurId, transcriptId, enabled, retry]);
  return { result, error, recovering, retry: () => setRetry((n) => n + 1) };
}

export function SourcesPanel({
  shiurId,
  title,
  teacher,
  result,
  error,
  onRetry,
  onSeek,
  recovering = false,
}: {
  shiurId: number;
  title: string;
  teacher: string;
  result: SourcesResult | null;
  error: string;
  onRetry: () => void;
  onSeek: (seconds: number) => void;
  recovering?: boolean;
}) {
  const [sheet, setSheet] = useState(false);
  return (
    <div className="study-sources">
      <p className="study-note-label">
        Explicit transcript citations linked through Sefaria. Incomplete,
        ambiguous, and context-filled references are omitted. Timestamps mark
        the start of the transcript segment. Quoted passages without a complete
        citation are not identified.
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
      {recovering && !error && (
        <output className="study-state">
          Connection interrupted. Retrying automatically…
        </output>
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
          Some sources or repeated timestamps were omitted because this
          transcript reached processing limits.
        </p>
      )}
      {!!result?.omitted && (
        <details className="source-omissions">
          <summary>Why references were omitted ({result.omitted})</summary>
          <ul>
            {Object.entries(result.omissionCounts).map(([reason, count]) => (
              <li key={reason}>
                {omissionLabels[reason as OmissionReason]}: {count}
              </li>
            ))}
          </ul>
          <p className="study-note-label">
            Examples from the transcript. These are excluded from sources and
            source sheets.
          </p>
          <ol>
            {result.omissions.map((omission, i) => (
              <li key={`${omission.offset}-${omission.reason}-${i}`}>
                <span>{omissionLabels[omission.reason]}</span>
                {omission.mention && <q dir="auto">{omission.mention}</q>}
                <button
                  className="study-time"
                  type="button"
                  onClick={() => onSeek(omission.startMs / 1000)}
                >
                  {timeLabel(omission.startMs / 1000)}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {sheet && result?.status === 'ready' && (
        <SourceSheetPreview
          shiurId={shiurId}
          title={title}
          teacher={teacher}
          sources={result.sources}
          limited={result.limited}
          transcriptId={result.transcriptId}
          onSeek={onSeek}
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
  transcriptId,
  title,
  teacher,
  sources,
  limited,
  onSeek,
}: {
  shiurId: number;
  transcriptId: string;
  title: string;
  teacher: string;
  sources: TranscriptSource[];
  limited: boolean;
  onSeek: (seconds: number) => void;
}) {
  const [cache, setCache] = useState<Record<string, SourceText>>({});
  const cacheRef = useRef(cache);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [language, setLanguage] = useState<SheetLanguage>('both');
  const [extent, setExtent] = useState<'excerpt' | 'full'>('excerpt');
  const [order, setOrder] = useState('time');
  const [selected, setSelected] = useState(
    () => new Set(sources.map((s) => s.ref)),
  );
  const chosen = sources.filter((s) => selected.has(s.ref));
  if (order === 'category')
    chosen.sort(
      (a, b) =>
        a.category.localeCompare(b.category) || a.ref.localeCompare(b.ref),
    );
  const refs = chosen.map((s) => s.ref).join('\0');
  const texts = Object.fromEntries(
    chosen
      .map((s) => [s.ref, cache[`${extent}:${s.ref}`]])
      .filter(([, text]) => text),
  ) as Record<string, SourceText>;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setFailed(false);
    const remaining = refs
      ? refs.split('\0').filter((ref) => !cacheRef.current[`${extent}:${ref}`])
      : [];
    const read = async () => {
      while (remaining.length && !abort.signal.aborted) {
        const ref = remaining.shift()!;
        try {
          const response = await sourceRequest(
            `/api/source-text?id=${shiurId}&revision=${encodeURIComponent(transcriptId)}&extent=${extent}&ref=${encodeURIComponent(ref)}`,
            abort.signal,
          );
          const text = (await response.json()) as SourceText;
          if (text.ref !== ref) throw new Error('Different source');
          if (!abort.signal.aborted) {
            cacheRef.current = {
              ...cacheRef.current,
              [`${extent}:${ref}`]: text,
            };
            setCache(cacheRef.current);
          }
        } catch {
          if (!abort.signal.aborted) setFailed(true);
        }
      }
    };
    void Promise.all([read(), read(), read()]).then(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [shiurId, transcriptId, refs, extent, retry]);
  const documentHtml = () =>
    renderSourceSheet({
      shiurId,
      title,
      teacher,
      origin: window.location.origin,
      sources: chosen,
      texts,
      limited,
      language,
      extent,
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
    const cleanup = () => frame.remove();
    const timeout = setTimeout(cleanup, 120000);
    frame.onload = () => {
      const target = frame.contentWindow;
      if (!target) {
        clearTimeout(timeout);
        cleanup();
        return;
      }
      target.addEventListener(
        'afterprint',
        () => {
          clearTimeout(timeout);
          cleanup();
        },
        { once: true },
      );
      try {
        target.focus();
        target.print();
      } catch {
        clearTimeout(timeout);
        cleanup();
      }
    };
    frame.srcdoc = documentHtml();
    document.body.append(frame);
  };
  return (
    <section className="source-sheet-preview" aria-label="Source sheet preview">
      <div className="source-sheet-tools">
        <span>Source sheet preview · {chosen.length} selected</span>
        <button
          type="button"
          disabled={loading || !chosen.length}
          onClick={download}
        >
          <Download size={14} />
          Download sheet
        </button>
        <button
          type="button"
          disabled={loading || !chosen.length}
          onClick={print}
        >
          <Printer size={14} />
          Print / Save PDF
        </button>
      </div>
      <fieldset className="source-sheet-options">
        <legend>Customize sheet</legend>
        <label>
          Language
          <select
            aria-label="Language"
            value={language}
            onChange={(e) => setLanguage(e.target.value as SheetLanguage)}
          >
            <option value="both">Hebrew / original and English</option>
            <option value="he">Hebrew / original</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          Source text
          <select
            aria-label="Source text"
            value={extent}
            onChange={(e) => setExtent(e.target.value as 'excerpt' | 'full')}
          >
            <option value="excerpt">Short excerpts</option>
            <option value="full">Complete cited text</option>
          </select>
        </label>
        <label>
          Order
          <select
            aria-label="Order"
            value={order}
            onChange={(e) => setOrder(e.target.value)}
          >
            <option value="time">First mention</option>
            <option value="category">Category</option>
          </select>
        </label>
        <details>
          <summary>
            Choose sources ({chosen.length} of {sources.length})
          </summary>
          <div className="source-selection-actions">
            <button
              type="button"
              onClick={() => setSelected(new Set(sources.map((s) => s.ref)))}
            >
              Select all
            </button>
            <button type="button" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
          {sources.map((source) => (
            <label key={source.ref} className="source-selection">
              <input
                type="checkbox"
                checked={selected.has(source.ref)}
                onChange={(e) =>
                  setSelected((old) => {
                    const next = new Set(old);
                    if (e.target.checked) next.add(source.ref);
                    else next.delete(source.ref);
                    return next;
                  })
                }
              />
              {source.ref}
            </label>
          ))}
        </details>
      </fieldset>
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
          Loading selected source text from Sefaria…
        </output>
      )}
      {failed && (
        <output className="study-state">
          Some source text is unavailable. Its citation links remain in the
          sheet.{' '}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Retry missing source text
          </button>
        </output>
      )}
      {!chosen.length && (
        <p className="study-state">
          Choose at least one source to download or print.
        </p>
      )}
      {chosen.map((source, index) => (
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
          <div className="source-times">
            Mentioned at{' '}
            {Array.from(new Set(source.occurrences.map((o) => o.startMs))).map(
              (ms) => (
                <button
                  key={ms}
                  type="button"
                  className="study-time"
                  onClick={() => onSeek(ms / 1000)}
                >
                  {timeLabel(ms / 1000)}
                </button>
              ),
            )}
          </div>
          {sourceEditions(texts[source.ref], language).map((edition, i) => (
            <div key={edition.title + i}>
              <div className="source-edition-text" dir={edition.direction}>
                {edition.text.map((line, j) => (
                  <p key={j}>{line}</p>
                ))}
              </div>
              {edition.truncated && (
                <p className="study-note-label">
                  {extent === 'excerpt'
                    ? 'Excerpt'
                    : 'Long text shortened for this sheet'}
                  ; open Sefaria for the complete cited text.
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
          {!loading && !sourceEditions(texts[source.ref], language).length && (
            <p className="study-state">
              Text in the selected language is unavailable. Read this source on
              Sefaria.
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
