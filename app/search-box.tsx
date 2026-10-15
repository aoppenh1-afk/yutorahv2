/* oxlint-disable jsx-a11y/prefer-tag-over-role -- ARIA combobox options contain names, entity types and live counts; native select cannot represent these. */
'use client';
import { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
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
import {
  suggestSearch,
  combineSearchSuggestions,
  highlightParts,
  type SearchSuggestion,
  type ShiurSuggestion,
} from '@/lib/search-discovery';
import { useShiurSuggestions } from '@/hooks/use-shiur-suggestions';

const recentKey = 'yutorah-recent-searches-v1';
export function SearchBox({
  value,
  onChange,
  onSearch,
  onSelect,
  onSelectShiur,
  directory,
}: {
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  onSelect: (suggestion: SearchSuggestion) => void;
  onSelectShiur: (suggestion: ShiurSuggestion) => void;
  directory: Directory | null;
}) {
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const deferred = useDeferredValue(value);
  const directorySuggestions = useMemo(
    () => suggestSearch(deferred, directory),
    [deferred, directory],
  );
  const history = value.trim() ? [] : recent;
  const shiurim = useShiurSuggestions(value, open);
  const suggestions = useMemo(
    () => combineSearchSuggestions(directorySuggestions, shiurim.items),
    [directorySuggestions, shiurim.items],
  );
  const count = suggestions.length + history.length;
  const showSuggestions = open && (count > 0 || shiurim.status !== 'idle');
  const optionKey = (index: number) => {
    const suggestion = suggestions[index];
    return suggestion
      ? `${suggestion.kind}-${suggestion.id}`
      : history[index - suggestions.length] || null;
  };
  const activeIndex =
    Array.from({ length: count }, (_, index) => index).find(
      (index) => optionKey(index) === selectedKey,
    ) ?? -1;
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
    if (open && activeIndex >= 0)
      document
        .getElementById(`search-option-${activeIndex}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);
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
    setSelectedKey(null);
    input.current?.blur();
    onSearch(query);
  };
  const choose = (index: number) => {
    if (index < suggestions.length) {
      setOpen(false);
      setSelectedKey(null);
      input.current?.blur();
      const suggestion = suggestions[index];
      if (suggestion.kind === 'shiur') onSelectShiur(suggestion);
      else onSelect(suggestion);
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
      <div className="search-field">
      <form
        className="main-search"
        onSubmit={(e) => {
          e.preventDefault();
          if (open && activeIndex >= 0) choose(activeIndex);
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
            setSelectedKey(null);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') {
              setOpen(false);
              setSelectedKey(null);
            }
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
              e.preventDefault();
              setOpen(true);
              const next =
                e.key === 'ArrowDown'
                  ? (activeIndex + 1) % count
                  : activeIndex <= 0
                    ? count - 1
                    : activeIndex - 1;
              setSelectedKey(optionKey(next));
            }
          }}
          placeholder="Shiur, topic, teacher, or series"
          aria-label="Search YUTorah"
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? 'search-suggestions' : undefined}
          aria-describedby="search-matching-hint"
          aria-activedescendant={
            open && activeIndex >= 0
              ? `search-option-${activeIndex}`
              : undefined
          }
          autoComplete="off"
          enterKeyHint="search"
          maxLength={300}
        />
        {value && (
          <button
            type="button"
            className="clear-search"
            aria-label="Clear search"
            onClick={() => {
              onChange('');
              setSelectedKey(null);
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
      {showSuggestions && (
        <div className="search-suggestion-panel">
          <div className="suggestion-heading">
            <span>
              {value.trim() ? 'From the YUTorah library' : 'Recent searches'}
            </span>
            {!value.trim() && history.length > 0 && (
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
                  aria-selected={activeIndex === i}
                  className={
                    'search-option ' + (activeIndex === i ? 'selected' : '')
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                  onMouseEnter={() => {
                    setSelectedKey(optionKey(i));
                  }}
                >
                  <span className="suggestion-icon">
                    <Icon size={18} />
                  </span>
                  <span className="suggestion-name">
                    <strong dir="auto">
                      {highlightParts(s.name, value).map((part, index) =>
                        part.match ? (
                          <mark key={index}>{part.text}</mark>
                        ) : (
                          part.text
                        ),
                      )}
                    </strong>
                    <small>
                      {s.kind === 'shiur'
                        ? 'Open shiur'
                        : s.kind === 'topic'
                          ? `Topic · ${s.context}`
                          : s.context}
                    </small>
                  </span>
                  {s.kind === 'shiur' ? (
                    <span className="suggestion-kind">Shiur</span>
                  ) : (
                    <span className="suggestion-count">
                      {s.count.toLocaleString()} <span>shiurim</span>
                    </span>
                  )}
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
                aria-selected={activeIndex === i}
                className={
                  'search-option ' + (activeIndex === i ? 'selected' : '')
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                onMouseEnter={() => {
                  setSelectedKey(optionKey(i));
                }}
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
          <div className="suggestion-status" role="status">
            {shiurim.status === 'loading'
              ? 'Searching shiurim…'
              : shiurim.status === 'error'
                ? 'Shiur suggestions are unavailable. Press Enter to search.'
                : shiurim.status === 'ready' && !count
                  ? 'No matching titles. Press Enter to search the library.'
                  : shiurim.items.length
                    ? `${shiurim.items.length} matching shiurim`
                    : ''}
          </div>
          {value.trim() && (
            <button
              type="button"
              className="suggestion-all-results"
              onClick={() => submit(value)}
            >
              Search all results <ArrowRight size={15} />
            </button>
          )}
          <div className="suggestion-footer">
            <span>↑ ↓ to explore</span>
            <span>Enter to select</span>
            <span>Esc to close</span>
          </div>
        </div>
      )}
      </div>
      <p id="search-matching-hint" className="search-matching-hint">
        Ask in your own words, or search a topic, teacher, or series. Typos and
        partial words work too.
      </p>
    </search>
  );
}
