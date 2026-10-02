'use client';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { Download, Loader2 } from 'lucide-react';
import { timeLabel } from '@/lib/library';
import { sourceHighlights } from '@/lib/source-highlights';
import { SourcesPanel, useTranscriptSources } from './sources-panel';

type Content = {
  id: string;
  transcriptId: string;
  title: string;
  teacher: string;
  text: string;
  segments: Array<{
    startMs: number;
    endMs: number;
    text: string;
    speaker: string | null;
  }>;
  notes: {
    status: string;
    markdown: string | null;
    cleanedText: string | null;
  } | null;
};
export function TranscriptReader({
  shiurId,
  onSeek,
}: {
  shiurId: number;
  onSeek: (seconds: number) => void;
}) {
  const [content, setContent] = useState<Content | null>(null);
  const [tab, setTab] = useState<'transcript' | 'notes' | 'sources'>(
    'transcript',
  );
  const [sourcesEnabled, setSourcesEnabled] = useState(false);
  const [state, setState] = useState('Loading transcript…');
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const sources = useTranscriptSources(
    shiurId,
    content?.transcriptId,
    sourcesEnabled,
  );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let awaitingNotes = 0;
    setContent(null);
    setTab('transcript');
    setSourcesEnabled(false);
    setLoading(true);
    const read = async () => {
      try {
        const response = await fetch(`/api/transcript?id=${shiurId}`, {
          signal: abort.signal,
        });
        const data = (await response.json()) as Content & { error?: string };
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'A transcript has not been completed for this shiur yet.'
              : data.error || 'Transcript is unavailable.',
          );
        if (abort.signal.aborted) return;
        setContent(data);
        setState('');
        if (
          (!data.notes && awaitingNotes++ < 3) ||
          (data.notes &&
            ['queued', 'cleaning', 'generating'].includes(data.notes.status))
        )
          timer = setTimeout(() => void read(), 10000);
      } catch (error) {
        if (!abort.signal.aborted)
          setState(
            error instanceof Error
              ? error.message
              : 'Transcript is unavailable.',
          );
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [shiurId, retry]);
  const download = () => {
    if (!content) return;
    const text =
      tab === 'notes'
        ? content.notes?.markdown
        : content.segments
            .map(
              (s) =>
                `[${timeLabel(s.startMs / 1000)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`,
            )
            .join('\n\n');
    if (!text) return;
    const url = URL.createObjectURL(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `shiur-${shiurId}-${tab === 'notes' ? 'notes.md' : 'transcript.txt'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      className="detail-section generated-study"
      aria-label="Transcript, study notes, and sources"
    >
      <h3>Transcript &amp; study tools</h3>
      <div className="study-tabs">
        <button
          type="button"
          aria-pressed={tab === 'transcript'}
          onClick={() => setTab('transcript')}
        >
          Transcript
        </button>
        <button
          type="button"
          aria-pressed={tab === 'notes'}
          onClick={() => setTab('notes')}
        >
          Study notes
        </button>
        <button
          type="button"
          aria-pressed={tab === 'sources'}
          onClick={() => {
            setTab('sources');
            setSourcesEnabled(true);
          }}
        >
          Sources
        </button>
        <button type="button" onClick={() => setRetry((n) => n + 1)}>
          Refresh
        </button>
        {content &&
          (tab === 'transcript' ||
            (tab === 'notes' && content.notes?.markdown)) && (
            <button className="study-download" type="button" onClick={download}>
              <Download size={14} /> Download
            </button>
          )}
      </div>
      {loading ? (
        <p className="feed-loading">
          <Loader2 size={14} className="spin" /> Loading transcript…
        </p>
      ) : state ? (
        <output className="study-state">
          {state}{' '}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Refresh
          </button>
        </output>
      ) : content && tab === 'transcript' ? (
        <div className="study-transcript">
          {content.segments.map((segment, index) => {
            const spans = sourceHighlights(
              sources.result?.transcriptId === content.transcriptId
                ? sources.result.sources
                : [],
              index,
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
      ) : content && tab === 'sources' ? (
        <SourcesPanel
          key={content.transcriptId}
          shiurId={shiurId}
          title={content.title}
          teacher={content.teacher}
          result={sources.result}
          error={sources.error}
          recovering={sources.recovering}
          onRetry={sources.retry}
          onSeek={onSeek}
        />
      ) : content?.notes?.markdown ? (
        <div className="study-markdown" dir="auto">
          <p className="study-note-label">
            Automatically generated from this shiur’s transcript.
          </p>
          <Markdown
            skipHtml
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
            {content.notes.markdown}
          </Markdown>
        </div>
      ) : (
        <output className="study-state">
          {content?.notes &&
          ['queued', 'cleaning', 'generating'].includes(content.notes.status)
            ? 'Study notes are being generated.'
            : content?.notes?.status === 'failed'
              ? 'Study notes could not be generated yet. The transcript is available.'
              : 'Study notes have not been generated for this shiur yet.'}
        </output>
      )}
    </section>
  );
}
