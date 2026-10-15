'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { FilterSelect } from './ui';
import { timeLabel } from '@/lib/library';
import type { Shiur } from '@/lib/yutorah';
import type {
  NotesSearchHit,
  NotesSearchResult,
} from '@/lib/notes-search-types';
import { highlightParts } from '@/lib/search-discovery';

type AudioHit = {
  shiurId: string;
  title: string;
  teacher: string;
  mediaUrl: string | null;
  startMs: number;
  text: string;
  spellingExpanded?: boolean;
};
type MatchMode = 'terms' | 'phrase' | 'smart';
type Match = { shiur: Shiur; audio: AudioHit[]; notes?: NotesSearchHit };

function combineMatches(notes: NotesSearchHit[], audio: AudioHit[]) {
  const matches = new Map<number, Match>();
  for (const hit of notes)
    matches.set(hit.shiur.id, { shiur: hit.shiur, notes: hit, audio: [] });
  for (const hit of audio) {
    const id = Number(hit.shiurId);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    let match = matches.get(id);
    if (!match) {
      match = {
        shiur: {
          id,
          title: hit.title,
          teacher: hit.teacher,
          teacherId: 0,
          audio: hit.mediaUrl || '',
          image: '',
          url: `https://yutorah.org/lectures/details?shiurID=${id}`,
          duration: 0,
          date: '',
          topics: [],
          category: '',
          language: '',
          series: '',
          seriesId: 0,
          description: '',
          format: 'mp3',
          materials: [],
        },
        audio: [],
      };
      matches.set(id, match);
    }
    if (!match.audio.some((item) => item.startMs === hit.startMs))
      match.audio.push(hit);
  }
  return [...matches.values()];
}

export default function InsideShiurSearch({
  query,
  onSelect,
  renderRows,
}: {
  query: string;
  onSelect: (shiur: Shiur) => void;
  renderRows: (
    shiurim: Shiur[],
    excerpts: ReadonlyMap<number, React.ReactNode>,
    onDetails: (shiur: Shiur) => void,
  ) => React.ReactNode;
}) {
  const [mode, setMode] = useState<MatchMode>('terms');
  const [notes, setNotes] = useState<NotesSearchResult | null>(null);
  const [audio, setAudio] = useState<AudioHit[]>([]);
  const [details, setDetails] = useState<Record<number, Shiur>>({});
  const [notesLoading, setNotesLoading] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [notesError, setNotesError] = useState('');
  const [audioError, setAudioError] = useState('');
  const [retry, setRetry] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const current = useRef({ query, mode });
  current.current = { query, mode };
  const loadNotes = async (
    page: number,
    prior: NotesSearchResult | null = null,
  ) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const identity = current.current;
    setNotesLoading(true);
    setNotesError('');
    try {
      const params = new URLSearchParams({
        q: identity.query,
        mode: identity.mode === 'phrase' ? 'phrase' : 'terms',
        page: String(page),
      });
      if (prior) params.set('snapshot', prior.snapshot);
      const response = await fetch('/api/notes-search?' + params, {
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || 'Written notes could not be searched.');
      if (!Array.isArray(body.items) || typeof body.total !== 'number')
        throw new Error('Written notes could not be searched.');
      if (
        !controller.signal.aborted &&
        identity.query === current.current.query &&
        identity.mode === current.current.mode
      )
        setNotes(
          prior ? { ...body, items: [...prior.items, ...body.items] } : body,
        );
    } catch (reason) {
      if (!controller.signal.aborted)
        setNotesError(
          reason instanceof Error
            ? reason.message
            : 'Written notes could not be searched.',
        );
    } finally {
      if (!controller.signal.aborted) setNotesLoading(false);
    }
  };
  const loadRef = useRef(loadNotes);
  loadRef.current = loadNotes;
  useEffect(() => {
    setNotes(null);
    setNotesError('');
    setNotesLoading(false);
    if (query.trim()) void loadRef.current(1);
    return () => abort.current?.abort();
  }, [query, mode, retry]);
  useEffect(() => {
    const controller = new AbortController();
    setAudio([]);
    setDetails({});
    setAudioError('');
    setAudioLoading(!!query.trim());
    if (!query.trim()) return;
    const params = new URLSearchParams({ q: query, mode });
    void (async () => {
      try {
        const response = await fetch('/api/transcript-search?' + params, {
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.error || 'Audio transcripts could not be searched.',
          );
        if (!Array.isArray(body.results))
          throw new Error('Audio transcripts could not be searched.');
        if (!controller.signal.aborted) setAudio(body.results);
      } catch (reason) {
        if (!controller.signal.aborted)
          setAudioError(
            reason instanceof Error
              ? reason.message
              : 'Audio transcripts could not be searched.',
          );
      } finally {
        if (!controller.signal.aborted) setAudioLoading(false);
      }
    })();
    return () => controller.abort();
  }, [query, mode, retry]);
  const audioOnlyIds = [...new Set(audio.map((hit) => hit.shiurId))]
    .filter((id) => !notes?.items.some((hit) => String(hit.shiur.id) === id))
    .join(',');
  useEffect(() => {
    if (!audioOnlyIds) return;
    const controller = new AbortController();
    const ids = audioOnlyIds.split(',');
    let next = 0;
    // Transcript matches carry only a title and teacher. Fill the regular row's
    // artwork, duration and catalog metadata with a bounded pool of cached reads.
    void Promise.all(
      Array.from({ length: Math.min(3, ids.length) }, async () => {
        while (next < ids.length && !controller.signal.aborted) {
          const id = ids[next++];
          try {
            const response = await fetch(
              '/api/shiur?id=' + encodeURIComponent(id),
              { signal: controller.signal },
            );
            if (!response.ok) continue;
            const shiur = (await response.json()) as Shiur;
            if (
              shiur.id === Number(id) &&
              Array.isArray(shiur.topics) &&
              !controller.signal.aborted &&
              current.current.query === query
            )
              setDetails((old) => ({ ...old, [shiur.id]: shiur }));
          } catch {
            // Keep the match available; opening details has its existing retry UI.
          }
        }
      }),
    );
    return () => controller.abort();
  }, [audioOnlyIds, query]);
  const matches = combineMatches(notes?.items || [], audio).map((match) => ({
    ...match,
    shiur: match.notes ? match.shiur : details[match.shiur.id] || match.shiur,
  }));
  const loading = notesLoading || audioLoading;
  const excerpt = (text: string) =>
    highlightParts(text, query).map((part, i) =>
      part.match ? (
        <mark key={i}>{part.text}</mark>
      ) : (
        <span key={i}>{part.text}</span>
      ),
    );
  const excerpts = new Map(
    matches.map((match) => [
      match.shiur.id,
      <section
        key={match.shiur.id}
        className="shiur-match-excerpts"
        aria-label="Matching excerpts"
      >
        <span className="shiur-match-source">
          {match.notes ? 'Notes' : ''}
          {match.notes && match.audio[0] ? ' · ' : ''}
          {match.audio[0]
            ? `Audio ${timeLabel(match.audio[0].startMs / 1000)}`
            : ''}
        </span>
        <p className="row-description">
          <span dir="auto">
            {excerpt(match.notes?.excerpt || match.audio[0]?.text || '')}
          </span>
        </p>
      </section>,
    ]),
  );
  const openDetails = (shiur: Shiur) => {
    const url = new URL(window.location.href);
    url.searchParams.set('shiur', String(shiur.id));
    url.searchParams.delete('t');
    window.history.pushState({}, '', url);
    onSelect(shiur);
  };
  return (
    <section
      className="inside-shiur-search"
      aria-label="Search inside the shiur"
    >
      <div className="results-heading">
        <div aria-live="polite">
          <h2>
            {query.trim()
              ? `${matches.length.toLocaleString()} ${matches.length === 1 ? 'shiur' : 'shiurim'}${loading ? ' so far' : ' shown'}`
              : 'Inside the Shiur'}
          </h2>
          {notes && (
            <p>
              Written notes refreshed{' '}
              {new Date(notes.updatedAt).toLocaleDateString(undefined, {
                dateStyle: 'medium',
              })}
            </p>
          )}
        </div>
        <FilterSelect
          label="Match inside the shiur"
          value={mode}
          onChange={(value) => setMode(value as MatchMode)}
          options={[
            { value: 'terms', label: 'All words' },
            { value: 'phrase', label: 'Exact phrase' },
            { value: 'smart', label: 'Flexible audio' },
          ]}
        />
      </div>
      {mode === 'smart' && (
        <p>
          Audio also matches typos and partial words. Written notes match all
          entered words.
        </p>
      )}
      {!query.trim() && (
        <p className="transcript-search-state">
          Type a word or phrase above and press Enter.
        </p>
      )}
      {(notesError || audioError) && (
        <div className="transcript-search-state" role="alert">
          {audioError && <span>Audio: {audioError}</span>}
          {notesError && <span>Written notes: {notesError}</span>}
          <button
            className="text-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      )}
      {matches.length > 0 && (
        <div className="results-list">
          {renderRows(
            matches.map((match) => match.shiur),
            excerpts,
            openDetails,
          )}
        </div>
      )}
      {query.trim() &&
        !loading &&
        !matches.length &&
        !notesError &&
        !audioError && (
          <p className="transcript-search-state">
            No audio transcripts or written notes match these words. Try fewer
            words or another spelling.
          </p>
        )}
      {notes?.nextPage && (
        <div className="load-more">
          <button
            className="outline-button"
            disabled={notesLoading}
            onClick={() => void loadNotes(notes.nextPage!, notes)}
          >
            Load more shiurim
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      {loading && (
        <output className="transcript-search-state">
          <Loader2 size={16} className="animate-spin" /> Searching{' '}
          {notesLoading && audioLoading
            ? 'audio and written notes'
            : notesLoading
              ? 'written notes'
              : 'audio'}
          …
        </output>
      )}
    </section>
  );
}
