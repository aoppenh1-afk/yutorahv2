'use client';
import { useState } from 'react';
import {
  ArrowRight,
  Download,
  FileText,
  NotebookPen,
  Play,
  Search,
  Trash2,
} from 'lucide-react';
import type { Note, LibraryState } from '@/lib/library';
import type { Shiur } from '@/lib/yutorah';
import { searchText } from '@/lib/search-discovery';
import { timeLabel } from '@/lib/library';
import { StatePanel } from './ui';

export function Notebook({
  library,
  items,
  onOpen,
  onPlay,
  onRemove,
  onExplore,
  nested = false,
}: {
  library: LibraryState;
  items: Shiur[];
  onOpen: (id: number) => void;
  onPlay: (id: number, seconds: number) => void;
  onRemove: (note: Note) => void;
  onExplore: () => void;
  nested?: boolean;
}) {
  const [query, setQuery] = useState('');
  const Heading = nested ? 'h2' : 'h1';
  const titleFor = (note: Note) =>
    note.shiur || items.find((s) => s.id === note.shiurId);
  const notes = [...library.notes]
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .filter((n) => {
      const shiur = titleFor(n);
      return searchText(
        n.text + ' ' + (shiur?.title || '') + ' ' + (shiur?.teacher || ''),
      ).includes(searchText(query));
    });
  const exportNotes = () => {
    const markdown =
      '# My YUTorah notebook\n\n' +
      notes
        .map(
          (n) =>
            `## ${titleFor(n)?.title || 'Shiur ' + n.shiurId}\n${titleFor(n)?.teacher || ''}\n\n${n.text}\n\nAt ${timeLabel(n.seconds)} · ${new Date(n.date).toLocaleDateString()}\n\n[Open shiur](https://yutorah.org/lectures/details?shiurID=${n.shiurId})\n`,
        )
        .join('\n');
    const url = URL.createObjectURL(
      new Blob([markdown], { type: 'text/markdown' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'yutorah-notebook.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="notebook-view">
      <div className="view-heading">
        <div className="eyebrow">YOUR LEARNING</div>
        <Heading>{nested ? 'Study notes' : 'Your notebook'}</Heading>
        <p>Questions, sources, and thoughts worth coming back to.</p>
      </div>
      <div className="notebook-toolbar">
        <div className="directory-search">
          <Search size={18} />
          <input
            aria-label="Search your notes"
            placeholder="Search notes, shiurim, or teachers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          className="outline-button"
          disabled={!notes.length}
          onClick={exportNotes}
        >
          <Download size={16} />
          Export notes
        </button>
      </div>
      <p className="notebook-count">
        {notes.length} {notes.length === 1 ? 'note' : 'notes'} · Saved on this
        device
      </p>
      {notes.length ? (
        <div className="notebook-grid">
          {notes.map((note) => (
            <article key={note.id} className="notebook-card">
              <div className="notebook-card-heading">
                <span>
                  <NotebookPen size={15} />
                  {new Date(note.date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
                <button
                  className="icon-button"
                  aria-label={'Delete note: ' + note.text.slice(0, 45)}
                  onClick={() => onRemove(note)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <p className="notebook-text" dir="auto">
                {note.text}
              </p>
              <button
                className="notebook-source"
                onClick={() => onOpen(note.shiurId)}
              >
                <FileText size={18} />
                <span>
                  <strong>
                    {titleFor(note)?.title || 'Open shiur details'}
                  </strong>
                  <small>
                    {titleFor(note)?.teacher || 'From the YUTorah library'}
                  </small>
                </span>
                <ArrowRight size={15} />
              </button>
              <button
                className="note-time"
                onClick={() => onPlay(note.shiurId, note.seconds)}
              >
                <Play size={12} />
                Return to {timeLabel(note.seconds)}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <StatePanel
          title={
            query
              ? 'No notes match this search'
              : 'Keep a thought. Come back to it.'
          }
          description={
            query
              ? 'Try another word, title, or teacher.'
              : 'Open any shiur and write a note. Add one while listening to keep the timestamp, too.'
          }
        >
          <button
            className="primary-button"
            onClick={query ? () => setQuery('') : onExplore}
          >
            {query ? 'Clear search' : 'Find a shiur'}
            <ArrowRight size={16} />
          </button>
        </StatePanel>
      )}
    </section>
  );
}
