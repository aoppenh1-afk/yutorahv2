/* oxlint-disable jsx-a11y/prefer-tag-over-role -- ARIA combobox options contain names, entity types and live counts; native select cannot represent these. */
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  History,
  Library,
  Search,
  Users,
  X,
} from 'lucide-react';
import type { Directory } from '@/lib/yutorah';
import { suggestSearch, type SearchSuggestion } from '@/lib/search-discovery';

const recentKey = 'yutorah-recent-searches-v1';
export function SearchBox({
  value,
  onChange,
  onSearch,
  onSelect,
  directory,
}: {
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  onSelect: (suggestion: SearchSuggestion) => void;
  directory: Directory | null;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(-1);
  const [recent, setRecent] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const suggestions = useMemo(
    () => suggestSearch(value, directory),
    [value, directory],
  );
  const history = value.trim() ? [] : recent;
  const count = suggestions.length + history.length;
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(recentKey) || '[]',
      );
      if (Array.isArray(stored))
        setRecent(
          stored
            .filter(
              (q): q is string => typeof q === 'string' && q.length <= 300,
            )
            .slice(0, 5),
        );
    } catch {
      /* Search remains available without device storage. */
    }
  }, []);
  useEffect(() => {
    if (open && selected >= 0)
      document
        .getElementById(`search-option-${selected}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [selected, open]);
  const submit = (query: string) => {
    const trimmed = query.trim();
    if (trimmed) {
      const next = [
        trimmed,
        ...recent.filter((q) => q.toLowerCase() !== trimmed.toLowerCase()),
      ].slice(0, 5);
      setRecent(next);
      try {
        localStorage.setItem(recentKey, JSON.stringify(next));
      } catch {
        /* Optional history. */
      }
    }
    setOpen(false);
    setSelected(-1);
    onSearch(query);
  };
  const choose = (index: number) => {
    if (index < suggestions.length) {
      setOpen(false);
      setSelected(-1);
      onSelect(suggestions[index]);
    } else submit(history[index - suggestions.length]);
  };
  return (
    <search
      className="search-workbench"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <form
        className="main-search"
        onSubmit={(e) => {
          e.preventDefault();
          if (open && selected >= 0 && selected < count) choose(selected);
          else submit(value);
        }}
      >
        <Search size={22} aria-hidden="true" />
        <input
          ref={input}
          id="main-search"
          role="combobox"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setSelected(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              setSelected(-1);
            }
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
              e.preventDefault();
              setOpen(true);
              setSelected((old) =>
                e.key === 'ArrowDown'
                  ? (old + 1) % count
                  : old <= 0
                    ? count - 1
                    : old - 1,
              );
            }
          }}
          placeholder="Topic, teacher, or series"
          aria-label="Search YUTorah"
          aria-autocomplete="list"
          aria-expanded={open && count > 0}
          aria-controls={open && count ? 'search-suggestions' : undefined}
          aria-describedby="search-matching-hint"
          aria-activedescendant={
            open && selected >= 0 ? `search-option-${selected}` : undefined
          }
          autoComplete="off"
          maxLength={300}
        />
        {value && (
          <button
            type="button"
            className="clear-search"
            aria-label="Clear search"
            onClick={() => {
              onChange('');
              setSelected(-1);
              setOpen(true);
              input.current?.focus();
            }}
          >
            <X size={17} />
          </button>
        )}
        <kbd>⌘ K</kbd>
        <button type="submit" aria-label="Search">
          <ArrowRight size={21} />
        </button>
      </form>
      <p id="search-matching-hint" className="search-matching-hint">
        Ask in your own words, or search a topic, teacher, or series. Typos and
        partial words work too.
      </p>
      {open && count > 0 && (
        <div className="search-suggestion-panel">
          <div className="suggestion-heading">
            <span>
              {suggestions.length
                ? 'From the YUTorah library'
                : 'Recent searches'}
            </span>
            {!suggestions.length && (
              <button
                type="button"
                onClick={() => {
                  setRecent([]);
                  try {
                    localStorage.removeItem(recentKey);
                  } catch {}
                }}
              >
                Clear history
              </button>
            )}
          </div>
          <div
            id="search-suggestions"
            role="listbox"
            aria-label="Search suggestions"
          >
            {suggestions.map((s, i) => {
              const Icon =
                s.kind === 'teacher'
                  ? Users
                  : s.kind === 'series'
                    ? Library
                    : BookOpen;
              return (
                <div
                  key={`${s.kind}-${s.id}`}
                  id={`search-option-${i}`}
                  role="option"
                  tabIndex={-1}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      choose(i);
                    }
                  }}
                  aria-selected={selected === i}
                  className={
                    'search-option ' + (selected === i ? 'selected' : '')
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                  onMouseEnter={() => setSelected(i)}
                >
                  <span className="suggestion-icon">
                    <Icon size={18} />
                  </span>
                  <span className="suggestion-name">
                    <strong dir="auto">{s.name}</strong>
                    <small>
                      {s.kind === 'topic' ? `Topic · ${s.context}` : s.context}
                    </small>
                  </span>
                  <span className="suggestion-count">
                    {s.count.toLocaleString()} <span>shiurim</span>
                  </span>
                  <ArrowRight size={15} />
                </div>
              );
            })}
            {history.map((q, i) => (
              <div
                key={q}
                id={`search-option-${i}`}
                role="option"
                tabIndex={-1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    choose(i);
                  }
                }}
                aria-selected={selected === i}
                className={
                  'search-option ' + (selected === i ? 'selected' : '')
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                onMouseEnter={() => setSelected(i)}
              >
                <span className="suggestion-icon">
                  <History size={18} />
                </span>
                <span className="suggestion-name">
                  <strong>{q}</strong>
                </span>
                <ArrowRight size={15} />
              </div>
            ))}
          </div>
          <div className="suggestion-footer">
            <span>↑ ↓ to explore</span>
            <span>Enter to select</span>
            <span>Esc to close</span>
          </div>
        </div>
      )}
    </search>
  );
}
