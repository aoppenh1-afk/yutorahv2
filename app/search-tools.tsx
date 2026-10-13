'use client';
import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Bookmark,
  BookmarkPlus,
  Check,
  Clock3,
  Headphones,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { parseSearch, type Directory } from '@/lib/yutorah';
import type { LibraryState } from '@/lib/library';
import { noFilters, type Filters } from '@/lib/search-filters';

export function SearchPresets({
  query,
  filters,
  onSearch,
}: {
  query: string;
  filters: Filters;
  onSearch: (query: string, filters: Filters) => void;
}) {
  return (
    <div className="search-presets">
      <button
        onClick={() =>
          onSearch(query, {
            ...filters,
            max: '20',
            min: '',
            format: 'audio',
          })
        }
      >
        <Headphones size={14} />A short listen
      </button>
      <button
        onClick={() => onSearch(query, { ...filters, min: '45', max: '' })}
      >
        <Clock3 size={14} />A deeper dive
      </button>
      <button
        onClick={() => {
          const date = new Date();
          date.setDate(date.getDate() - 7);
          onSearch(query, {
            ...filters,
            after: date.toISOString().slice(0, 10),
            before: '',
            sort: 'new',
            dateBasis: 'uploaded',
          });
        }}
      >
        <Sparkles size={14} />
        New this week
      </button>
    </div>
  );
}

export function QueryPreview({
  query,
  directory,
  literal = false,
  resolved = false,
}: {
  query: string;
  directory: Directory | null;
  literal?: boolean;
  resolved?: boolean;
}) {
  const interpretation = useMemo(
    () =>
      query.trim()
        ? parseSearch(query, { literal, resolved }, directory || undefined)
        : null,
    [query, directory, literal, resolved],
  );
  const labels = interpretation?.labels || [];
  if (!labels.length || query.trim() === interpretation?.term) return null;
  return (
    <p className="query-preview">
      <Sparkles size={14} />
      <span>We&apos;ll search for</span>
      {interpretation?.term && <span>Keywords: {interpretation.term}</span>}
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </p>
  );
}

export async function copySearchLink(
  query: string,
  filters: Filters,
  notify: (text: string) => void,
) {
  const url = new URL(window.location.origin);
  url.searchParams.set('view', 'search');
  if (query) url.searchParams.set('q', query);
  Object.entries(filters).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  try {
    await navigator.clipboard.writeText(url.href);
    notify('Search link copied with all filters.');
  } catch {
    notify('Your browser could not copy the link.');
  }
}

export function SearchTools({
  query,
  filters,
  directory,
  library,
  update,
  onSearch,
  notify,
}: {
  query: string;
  filters: Filters;
  directory: Directory | null;
  library: LibraryState;
  update: (fn: (old: LibraryState) => LibraryState) => void;
  onSearch: (query: string, filters: Filters) => void;
  notify: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const saveSearch = () => {
    const existing = library.savedSearches.find(
      (s) =>
        s.query === query &&
        JSON.stringify({ ...noFilters, ...s.filters }) ===
          JSON.stringify(filters),
    );
    if (existing) {
      notify('This search is already saved.');
      return;
    }
    setName(
      query ||
        directory?.teachers.find((t) => String(t.id) === filters.teacher)
          ?.name ||
        directory?.topics.find((t) => String(t.id) === filters.topic)?.name ||
        'My filtered search',
    );
    setSaving(true);
    setOpen(true);
  };
  return (
    <>
      <div className="search-save-tools">
        <button
          className="toolbar-button"
          onClick={() => {
            setSaving(false);
            setOpen(true);
          }}
        >
          <Bookmark size={15} />
          Saved
          {library.savedSearches.length > 0 && (
            <span className="tab-count">{library.savedSearches.length}</span>
          )}
        </button>
        {(query ||
          Object.entries(filters).some(
            ([key, value]) => key !== 'resolved' && value,
          )) && (
          <button className="toolbar-button" onClick={saveSearch}>
            <BookmarkPlus size={16} />
            Save search
          </button>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="saved-search-dialog">
          <DialogHeader>
            <DialogTitle>
              {saving ? 'Save this search' : 'Your saved searches'}
            </DialogTitle>
            <DialogDescription>
              {saving
                ? 'Keep the keywords, filters, and sort order together.'
                : 'Return to a search in one click. Saved on this device.'}
            </DialogDescription>
          </DialogHeader>
          {saving ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim()) return;
                update((old) => ({
                  ...old,
                  savedSearches: [
                    {
                      id: crypto.randomUUID(),
                      name: name.trim(),
                      query,
                      filters: { ...filters },
                      createdAt: new Date().toISOString(),
                    },
                    ...old.savedSearches,
                  ].slice(0, 30),
                }));
                setOpen(false);
                notify('Search saved with all filters.');
              }}
            >
              <label className="search-name-label">
                Search name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                />
              </label>
              <div className="saved-query-summary">
                <Search size={16} />
                {query || 'All keywords'}
                <span>
                  {
                    Object.entries(filters).filter(
                      ([key, value]) => key !== 'resolved' && value,
                    ).length
                  }{' '}
                  filters
                </span>
              </div>
              <button className="primary-button" type="submit">
                <Check size={16} />
                Save search
              </button>
            </form>
          ) : (
            <div className="saved-search-list">
              {library.savedSearches.length ? (
                library.savedSearches.map((s) => (
                  <article key={s.id}>
                    <button
                      onClick={() => {
                        setOpen(false);
                        onSearch(s.query, { ...noFilters, ...s.filters });
                      }}
                    >
                      <span className="saved-search-icon">
                        <Bookmark size={18} />
                      </span>
                      <span>
                        <strong>{s.name}</strong>
                        <small>
                          {s.query || 'All keywords'} ·{' '}
                          {Object.values(s.filters).filter(Boolean).length}{' '}
                          filters
                        </small>
                      </span>
                      <ArrowRight size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={'Remove saved search: ' + s.name}
                      onClick={() => {
                        update((old) => ({
                          ...old,
                          savedSearches: old.savedSearches.filter(
                            (v) => v.id !== s.id,
                          ),
                        }));
                        notify('Saved search removed.');
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </article>
                ))
              ) : (
                <div className="saved-search-empty">
                  <Bookmark size={28} />
                  <h3>Your best searches, a click away.</h3>
                  <p>Run a search, add your filters, and choose Save search.</p>
                  <button
                    className="outline-button"
                    onClick={() => setOpen(false)}
                  >
                    Back to search <X size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
