'use client';
import { useEffect, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { timeLabel } from '@/lib/library';

export type TranscriptHit = {
  shiurId: string;
  title: string;
  teacher: string;
  mediaUrl: string | null;
  startMs: number;
  endMs: number;
  text: string;
  matched: string;
  href: string;
  aliasesExpanded: boolean;
  spellingExpanded?: boolean;
};

export function TranscriptSearch({
  query,
  onSelect,
}: {
  query: string;
  onSelect: (hit: TranscriptHit) => void;
}) {
  const [mode, setMode] = useState<'phrase' | 'terms' | 'smart'>('smart');
  const [hits, setHits] = useState<TranscriptHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setError('');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setHits([]);
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ q: query, mode });
    fetch(`/api/transcript-search?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as {
          results?: TranscriptHit[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(body.error || 'Transcript search is unavailable.');
        if (!Array.isArray(body.results))
          throw new Error('Transcript search is unavailable.');
        return body.results;
      })
      .then((items) => {
        if (!controller.signal.aborted) setHits(items);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : 'Transcript search is unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, mode]);
  return (
    <section
      className="transcript-search"
      aria-label="Search inside shiur audio"
    >
      <div className="transcript-search-heading">
        <p>
          Find the moment a word or phrase is spoken, then jump straight to it
          in the audio.
        </p>
        <label>
          Match
          <select
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as 'phrase' | 'terms' | 'smart')
            }
          >
            <option value="smart">Typos & partial words</option>
            <option value="phrase">Exact phrase</option>
            <option value="terms">All words</option>
          </select>
        </label>
      </div>
      {!query.trim() ? (
        <p className="transcript-search-state">
          Type a word or phrase above and press Enter.
        </p>
      ) : loading ? (
        <p className="transcript-search-state">
          <Loader2 size={16} className="animate-spin" /> Searching transcripts…
        </p>
      ) : error ? (
        <output className="transcript-search-state">{error}</output>
      ) : hits.length ? (
        <div className="transcript-hits">
          {hits.map((hit, index) => (
            <a
              key={`${hit.shiurId}-${hit.startMs}-${index}`}
              href={hit.href}
              className="transcript-hit"
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onSelect(hit);
              }}
            >
              <span className="transcript-hit-title">
                {hit.teacher} — {hit.title}
              </span>
              <span className="transcript-hit-text" dir="auto">
                “{hit.text}”
              </span>
              <span className="transcript-hit-meta">
                <Play size={14} /> {timeLabel(hit.startMs / 1000)}
                {hit.spellingExpanded
                  ? ' · close spelling'
                  : hit.aliasesExpanded && hit.matched !== query.toLowerCase()
                    ? ` · matched ${hit.matched}`
                    : ''}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <p className="transcript-search-state">
          No completed transcript matches yet. New shiurim appear here after
          transcription finishes.
        </p>
      )}
    </section>
  );
}
