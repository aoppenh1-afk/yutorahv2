'use client';
import { useEffect, useRef, useState, useMemo, lazy } from 'react';
import { ScreenBoundary } from './screen-boundary';
import { useActiveSegment } from './playback';
const Markdown = lazy(() => import('react-markdown'));
const SourcesPanel = lazy(() =>
  import('./sources-panel').then((m) => ({ default: m.SourcesPanel })),
);
import type { OfficialStudy } from '@/lib/official-study';
import {
  Download,
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCw,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { NotesDownload, type NotesFormat } from './notes-download';
import { saveDownload } from '@/lib/save-download';
import { BoundedCache } from '@/lib/bounded-cache';
import { fetchStudy } from '@/lib/offline-content';
import { useOnline } from '@/lib/connectivity';
import { timeLabel } from '@/lib/library';
import type { ContentStatus } from '../packages/transcription/src/public-content';
import { indexSourceHighlights } from '@/lib/source-highlights';
import { useSourceCreator } from '@/hooks/use-source-creator';
import { remarkSourceLinks } from '@/lib/source-note-links';
import {
  remarkNotesDirection,
  stripNotesDirectionControls,
} from '@/lib/notes-direction';

type Content = {
  id: string;
  transcriptId: string;
  title: string;
  teacher: string;
  version?: string;
  source?: 'official-yutorah';
  segments: Array<{
    startMs: number;
    endMs: number;
    text: string;
    speaker: string | null;
  }>;
  notes: {
    status: string;
    markdown: string | null;
  } | null;
};
const readerVersions = new BoundedCache<Content>(8, 8 * 1024 * 1024);
type HostedStudyNote = {
  id: number;
  status: string;
  markdown: string | null;
  sourceHash?: string;
  notesHash?: string;
};
const hostedNotesCache = new BoundedCache<HostedStudyNote>(64, 4 * 1024 * 1024);
export function TranscriptReader({
  shiurId,
  onSeek,
  title,
  teacher,
}: {
  shiurId: number;
  onSeek: (seconds: number) => void;
  title?: string;
  teacher?: string;
}) {
  const online = useOnline();
  const [content, setContent] = useState<Content | null>(null);
  const [tab, setTab] = useState<
    'transcript' | 'notes' | 'sources' | 'summary'
  >('notes');
  const tabChosen = useRef(false);
  const choose = (next: typeof tab) => {
    tabChosen.current = true;
    setTab(next);
  };
  const [official, setOfficial] = useState<OfficialStudy | null>(null),
    [officialError, setOfficialError] = useState(''),
    [officialRetry, setOfficialRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setOfficial((old) => (old?.id === shiurId ? old : null));
    setOfficialError('');
    fetchStudy(
      '/api/official-study?id=' + shiurId + (officialRetry ? '&fresh=1' : ''),
      { signal: abort.signal },
    )
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        return d as OfficialStudy;
      })
      .then((d) => {
        if (!abort.signal.aborted) setOfficial(d);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setOfficialError(e.message);
      });
    return () => abort.abort();
  }, [shiurId, officialRetry, online]);
  const [state, setState] = useState('Loading transcript…');
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState('');
  const [hosted, setHosted] = useState<HostedStudyNote | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState<NotesFormat | null>(null);
  const [exportError, setExportError] = useState('');
  const exportLock = useRef(false);
  useEffect(() => {
    setExpanded(false);
    setExportError('');
  }, [shiurId]);
  const lastNotesRetry = useRef(retry);
  useEffect(() => {
    if (tab !== 'notes') return;
    const fresh = retry !== lastNotesRetry.current;
    lastNotesRetry.current = retry;
    const cacheKey = String(shiurId);
    if (fresh) hostedNotesCache.delete(cacheKey);
    const cached = online ? hostedNotesCache.get(cacheKey) : undefined;
    if (cached) {
      setHosted(cached);
      return;
    }
    const abort = new AbortController();
    setHosted({ id: shiurId, status: 'loading', markdown: null });
    void fetchStudy(`/api/study-notes?id=${shiurId}`, {
      signal: abort.signal,
      cache: fresh ? 'no-store' : 'default',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Notes unavailable');
        const note = {
          ...(await response.json()),
          id: shiurId,
        } as HostedStudyNote;
        if (!abort.signal.aborted) {
          hostedNotesCache.set(
            cacheKey,
            note,
            note.status === 'completed' ? 60 * 60_000 : 60_000,
          );
          setHosted(note);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setHosted({ id: shiurId, status: 'unavailable', markdown: null });
      });
    return () => abort.abort();
  }, [shiurId, retry, tab, online]);
  const hostedNote = hosted?.id === shiurId ? hosted : null;
  const displayedNotes =
    content?.source === 'official-yutorah' || !content?.notes?.markdown
      ? hostedNote
      : content.notes;
  const displayedNotesVersion =
    displayedNotes === hostedNote ? hostedNote?.notesHash : content?.version;
  useEffect(() => {
    if (tabChosen.current || tab !== 'notes' || loading || !content) return;
    if (!hostedNote || hostedNote.status === 'loading') return;
    if (!displayedNotes?.markdown) setTab('transcript');
  }, [tab, loading, content, hostedNote, displayedNotes]);
  const last = useRef<{ id: number; content: Content } | null>(null);
  const sources = useSourceCreator({
    shiurId,
    transcriptId: content?.transcriptId,
    version: content?.version,
    source: content?.source,
    enabled: online && !loading,
    onRevisionChange: () => setRetry((n) => n + 1),
  });
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let awaitingNotes = 0;
    let pendingNotes = false;
    let reading = false;
    let loaded = false;
    let current = last.current?.id === shiurId ? last.current.content : null;
    if (!current) {
      setContent(null);
      tabChosen.current = false;
      setTab('notes');
    }
    setLoading(!current);
    setRefreshError('');
    const read = async (statusOnly = false) => {
      if (abort.signal.aborted || document.hidden || reading) return;
      clearTimeout(timer);
      reading = true;
      try {
        const options = { signal: abort.signal };
        let version: string | undefined;
        if (
          (statusOnly || current) &&
          current &&
          online &&
          current.source !== 'official-yutorah'
        ) {
          const statusResponse = await fetch(
            `/api/transcript-status?id=${shiurId}`,
            options,
          );
          if (!statusResponse.ok) throw new Error('Could not refresh notes.');
          const status = (await statusResponse.json()) as ContentStatus;
          version = status.version;
          if (
            (!version || version === current.version) &&
            status.transcriptId === current.transcriptId &&
            (status.notes?.status !== 'completed' ||
              (version && version === current.version))
          ) {
            pendingNotes =
              !status.notes ||
              ['queued', 'cleaning', 'generating'].includes(
                status.notes.status,
              );
            if (!status.notes && awaitingNotes >= 3) pendingNotes = false;
            if (status.notes) {
              current = {
                ...current,
                notes: {
                  status: status.notes.status,
                  markdown: current.notes?.markdown ?? null,
                },
              };
              last.current = { id: shiurId, content: current };
              setContent(current);
            }
            if (pendingNotes && awaitingNotes++ < 10)
              timer = setTimeout(() => void read(true), 30_000);
            return;
          }
        }
        const query = new URLSearchParams({ id: String(shiurId) });
        if (version) query.set('version', version);
        if ((retry > 0 || statusOnly) && !version) query.set('fresh', 'true');
        const cached = version
          ? readerVersions.get(shiurId + ':' + version)
          : undefined;
        const response = cached
          ? Response.json(cached)
          : await fetchStudy(`/api/transcript?${query}`, {
              signal: abort.signal,
              cache:
                (retry > 0 || statusOnly) && !version ? 'no-store' : 'default',
            });
        const data = (await response.json()) as Content & { error?: string };
        if (!response.ok)
          throw new Error(
            !online
              ? 'This transcript was not saved for offline use. Connect to the internet to load it.'
              : response.status === 404
                ? 'A transcript has not been completed for this shiur yet.'
                : data.error || 'Transcript is unavailable.',
          );
        if (abort.signal.aborted) return;
        current = data;
        if (data.version)
          readerVersions.set(shiurId + ':' + data.version, data, 60 * 60_000);
        last.current = { id: shiurId, content: data };
        setContent(data);
        setState('');
        setRefreshError('');
        pendingNotes =
          data.source !== 'official-yutorah' &&
          online &&
          ((!data.notes && awaitingNotes < 3) ||
            Boolean(
              data.notes &&
              ['queued', 'cleaning', 'generating'].includes(data.notes.status),
            ));
        // Bound automatic retries even when notes remain queued indefinitely.
        if (pendingNotes && awaitingNotes++ < 10 && !document.hidden)
          timer = setTimeout(() => void read(true), 30_000);
      } catch (error) {
        pendingNotes = false;
        if (!abort.signal.aborted) {
          const message =
            error instanceof Error
              ? error.message
              : 'Transcript is unavailable.';
          if (current) {
            setState('');
            setRefreshError(message);
          } else setState(message);
        }
      } finally {
        reading = false;
        loaded = true;
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    const visibilityChanged = () => {
      clearTimeout(timer);
      if (!document.hidden && (!loaded || pendingNotes) && awaitingNotes <= 10)
        void read(loaded);
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [shiurId, retry, online]);
  const notesContent = displayedNotes?.markdown ? (
    <div className="study-markdown" dir="ltr">
      {content?.source === 'official-yutorah' &&
        hostedNote?.sourceHash &&
        hostedNote.sourceHash !== content.version && (
          <p className="study-note-label">
            These notes use an earlier version of the official transcript.
          </p>
        )}
      <ScreenBoundary>
        <Markdown
          skipHtml
          remarkPlugins={[
            [
              remarkSourceLinks,
              {
                sources:
                  sources.features.links &&
                  displayedNotesVersion &&
                  displayedNotesVersion === sources.result?.notesVersion
                    ? sources.result.sources
                    : [],
              },
            ],
            remarkNotesDirection,
          ]}
          allowedElements={[
            'h1',
            'h2',
            'h3',
            'p',
            'ul',
            'ol',
            'li',
            'strong',
            'em',
            'a',
            'code',
            'br',
          ]}
          components={{
            a: ({ children, ...props }) => (
              <a {...props} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
          }}
        >
          {stripNotesDirectionControls(displayedNotes.markdown)}
        </Markdown>
      </ScreenBoundary>
    </div>
  ) : null;
  const downloadNotes = async (format: NotesFormat) => {
    if (!displayedNotes?.markdown || exportLock.current) return;
    exportLock.current = true;
    setExporting(format);
    setExportError('');
    try {
      const markdown = displayedNotes.markdown;
      const blob =
        format === 'pdf'
          ? await (await import('@/lib/notes-pdf')).createNotesPdf(markdown)
          : await (await import('@/lib/notes-docx')).createNotesDocx(markdown);
      saveDownload(blob, `shiur-${shiurId}-notes.${format}`);
    } catch {
      setExportError('Could not download notes. Please try again.');
    } finally {
      exportLock.current = false;
      setExporting(null);
    }
  };
  const download = () => {
    if (!content) return;
    const text = content.segments
      .map(
        (s) =>
          `[${timeLabel(s.startMs / 1000)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`,
      )
      .join('\n\n');
    saveDownload(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
      `shiur-${shiurId}-transcript.txt`,
    );
  };
  return (
    <>
      <section
        className="detail-section generated-study"
        aria-label={'Transcript, notes, and sources'}
      >
        <div className="study-bar">
          <div className="study-tabs">
            <button
              type="button"
              aria-pressed={tab === 'notes'}
              onClick={() => choose('notes')}
            >
              Notes
            </button>
            <button
              type="button"
              aria-pressed={tab === 'transcript'}
              onClick={() => choose('transcript')}
            >
              Transcript
            </button>
            {official?.available && (
              <button
                type="button"
                aria-pressed={tab === 'summary'}
                onClick={() => choose('summary')}
              >
                Summaries
              </button>
            )}
            {online &&
              (sources.available.links ||
                sources.available.sheets ||
                !sources.configured ||
                sources.error) && (
                <button
                  type="button"
                  aria-pressed={tab === 'sources'}
                  onClick={() => choose('sources')}
                >
                  Sources
                </button>
              )}
          </div>
        </div>
        {tab !== 'sources' && (
          <div className="study-toolbar">
            <p className="study-note-label">
              {tab === 'notes' && displayedNotes?.markdown
                ? 'Auto-generated from the transcript.'
                : tab === 'transcript' && content?.source === 'official-yutorah'
                  ? 'From YUTorah, auto-generated.'
                  : tab === 'summary' && official
                    ? 'From YUTorah, auto-generated.'
                    : ''}
            </p>
            <div className="study-tools">
              {tab === 'transcript' && content && online && (
                <a
                  className="study-tool is-icon"
                  href={`/api/transcript-text?id=${shiurId}${content.version ? '&version=' + content.version : ''}${content.source === 'official-yutorah' ? '&source=official-yutorah' : ''}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open complete text"
                  title="Open complete text"
                >
                  <ExternalLink size={15} />
                </a>
              )}
              {tab === 'transcript' && content && (
                <button
                  className="study-tool"
                  type="button"
                  onClick={download}
                  aria-label="Download"
                  title="Download transcript"
                >
                  <Download size={15} />
                  <span>Download</span>
                </button>
              )}
              {tab === 'notes' && displayedNotes?.markdown && online && (
                <NotesDownload
                  busy={exporting}
                  onDownload={(format) => void downloadNotes(format)}
                />
              )}
              {tab === 'notes' && displayedNotes?.markdown && (
                <button
                  className="study-tool"
                  type="button"
                  onClick={() => setExpanded(true)}
                  aria-label="Expand notes"
                  title="Expand notes"
                >
                  <Maximize2 size={15} />
                  <span>Expand</span>
                </button>
              )}
              <button
                className="study-tool is-icon"
                type="button"
                disabled={!online}
                aria-label="Refresh"
                title="Refresh"
                onClick={() => {
                  setRetry((n) => n + 1);
                  setOfficialRetry((n) => n + 1);
                  sources.retry();
                }}
              >
                <RotateCw size={15} />
              </button>
            </div>
          </div>
        )}
        {!online && (
          <p className="study-note-label">
            Reading saved content offline. Reconnect and refresh to check for
            updates.
          </p>
        )}
        {official?.chapters.length && tab === 'transcript' ? (
          <details className="study-chapters">
            <summary>
              Chapters <span>{official.chapters.length}</span>
            </summary>
            <ol>
              {official.chapters.map((c, i) => (
                <li key={i}>
                  <button onClick={() => onSeek(c.start)}>
                    <span>{timeLabel(c.start)}</span>
                    <strong dir="auto">{c.title}</strong>
                  </button>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        {officialError && (
          <details className="study-chapters">
            <summary>Chapters & summaries unavailable</summary>
            <p>
              {officialError}{' '}
              <button onClick={() => setOfficialRetry((n) => n + 1)}>
                Retry
              </button>
            </p>
          </details>
        )}
        {exportError && tab === 'notes' && (
          <p role="alert" className="study-state">
            {exportError}
          </p>
        )}
        {refreshError && tab === 'transcript' && (
          <output className="study-state">
            {refreshError} Your loaded transcript is still available.
          </output>
        )}
        {tab === 'sources' ? (
          <ScreenBoundary>
            <SourcesPanel
              key={shiurId}
              shiurId={shiurId}
              title={title || content?.title || `Shiur ${shiurId}`}
              teacher={teacher || content?.teacher || 'YUTorah'}
              creator={sources}
              onSeek={onSeek}
            />
          </ScreenBoundary>
        ) : tab === 'summary' && official ? (
          <section className="official-summaries">
            {official.summary && <p dir="auto">{official.summary}</p>}
            {official.chapters.map((c, i) => (
              <section key={i}>
                <h3>
                  <button onClick={() => onSeek(c.start)}>
                    <span>{timeLabel(c.start)}</span>
                    <strong dir="auto">{c.title}</strong>
                  </button>
                </h3>
                {c.summary && <p dir="auto">{c.summary}</p>}
              </section>
            ))}
          </section>
        ) : tab !== 'notes' && loading ? (
          <p className="feed-loading">
            <Loader2 size={14} className="spin" /> Loading transcript…
          </p>
        ) : tab !== 'notes' && state ? (
          <output className="study-state">
            {state}{' '}
            {online && (
              <button
                type="button"
                onClick={() => {
                  setRetry((n) => n + 1);
                  setOfficialRetry((n) => n + 1);
                }}
              >
                Refresh
              </button>
            )}
          </output>
        ) : content && tab === 'transcript' ? (
          <TranscriptSegments
            key={content.transcriptId + ':' + (content.version ?? '')}
            content={content}
            sources={sources}
            shiurId={shiurId}
            onSeek={onSeek}
          />
        ) : displayedNotes?.markdown ? (
          notesContent
        ) : (
          <output className="study-state">
            {!online && displayedNotes?.status !== 'loading'
              ? 'These notes were not saved for offline use. Connect to the internet to load them.'
              : displayedNotes?.status === 'loading'
                ? 'Loading notes…'
                : displayedNotes?.status === 'unavailable'
                  ? 'Notes are temporarily unavailable. Try Refresh.'
                  : displayedNotes &&
                      ['queued', 'cleaning', 'generating'].includes(
                        displayedNotes.status,
                      )
                    ? 'Notes are being generated.'
                    : displayedNotes?.status === 'failed'
                      ? 'Notes could not be generated yet. The transcript is available.'
                      : 'Notes have not been generated for this shiur yet.'}
          </output>
        )}
      </section>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="notes-expanded translate-x-0 translate-y-0"
          showCloseButton={false}
        >
          <header className="notes-expanded-header">
            <div>
              <DialogTitle>Notes</DialogTitle>
              <DialogDescription dir="auto">
                {content?.title || `Shiur ${shiurId}`}
              </DialogDescription>
              <p className="study-note-label">
                Auto-generated from the transcript.
              </p>
            </div>
            <div className="study-tools">
              <NotesDownload
                busy={exporting}
                onDownload={(format) => void downloadNotes(format)}
              />
              <DialogClose
                className="study-tool"
                aria-label="Close expanded notes"
              >
                <Minimize2 size={15} />
                <span>Close</span>
              </DialogClose>
            </div>
          </header>
          {exportError && (
            <p role="alert" className="study-state">
              {exportError}
            </p>
          )}
          {notesContent}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TranscriptSegments({
  content,
  sources,
  shiurId,
  onSeek,
}: {
  content: Content;
  sources: ReturnType<typeof useSourceCreator>;
  shiurId: number;
  onSeek: (seconds: number) => void;
}) {
  const highlights = useMemo(
    () =>
      indexSourceHighlights(
        sources.features.links &&
          sources.result?.transcriptId === content.transcriptId
          ? sources.result.sources
          : [],
      ),
    [sources.result, sources.features.links, content.transcriptId],
  );
  const active = useActiveSegment(shiurId, content.segments);
  return (
    <div className="study-transcript">
      {content.segments.map((segment, index) => {
        const spans = (highlights.get(index) ?? []).filter(
          (span) =>
            !span.text ||
            segment.text.slice(span.startChar, span.endChar) === span.text,
        );
        let position = 0;
        const text = spans.flatMap((span) => {
          const before = segment.text.slice(position, span.startChar);
          position = span.endChar;
          return [
            before,
            <a
              className="transcript-source-link"
              key={`${span.startChar}-${span.ref}`}
              href={span.url}
              title={span.ref}
              target="_blank"
              rel="noreferrer"
            >
              {segment.text.slice(span.startChar, span.endChar)}
            </a>,
          ];
        });
        text.push(segment.text.slice(position));
        return (
          <div
            className="study-segment"
            aria-current={index === active ? 'true' : undefined}
            key={`${segment.startMs}-${index}`}
          >
            <button
              className="study-time"
              type="button"
              aria-label={`Play from ${timeLabel(segment.startMs / 1000)}`}
              onClick={() => onSeek(segment.startMs / 1000)}
            >
              {timeLabel(segment.startMs / 1000)}
            </button>
            <p dir="auto">
              {segment.speaker && <strong>{segment.speaker}: </strong>}
              {text}
            </p>
          </div>
        );
      })}
    </div>
  );
}
