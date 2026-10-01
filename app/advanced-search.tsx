'use client';
import { useState } from 'react';
import { ArrowRight, SlidersHorizontal } from 'lucide-react';
import type { Directory } from '@/lib/yutorah';
import { searchText } from '@/lib/search-discovery';

export type Filters = Record<
  | 'teacher'
  | 'series'
  | 'topic'
  | 'max'
  | 'min'
  | 'language'
  | 'format'
  | 'after'
  | 'before'
  | 'phrase'
  | 'exclude'
  | 'sort'
  | 'scope',
  string
>;
export const noFilters: Filters = {
  teacher: '',
  series: '',
  topic: '',
  max: '',
  min: '',
  language: '',
  format: '',
  after: '',
  before: '',
  phrase: '',
  exclude: '',
  scope: '',
  sort: '',
};

function EntityField({
  label,
  value,
  entries,
  onChange,
}: {
  label: string;
  value: string;
  entries: { id: number; name: string; count: number }[];
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const words = searchText(query).split(' ').filter(Boolean);
  const matches = entries.filter(
    (e) =>
      String(e.id) === value ||
      words.every((word) => searchText(e.name).includes(word)),
  );
  return (
    <div className="advanced-entity">
      <label>
        <span>{label}</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Find a ${label.toLowerCase()}…`}
          aria-label={`Find a ${label.toLowerCase()} in the directory`}
        />
      </label>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Any {label.toLowerCase()}</option>
        {value && !entries.some((e) => String(e.id) === value) && (
          <option value={value}>Selected {label.toLowerCase()}</option>
        )}
        {matches.slice(0, 100).map((e) => (
          <option key={e.id} value={String(e.id)}>
            {e.name} · {e.count.toLocaleString()}
          </option>
        ))}
        {value &&
          !matches.slice(0, 100).some((e) => String(e.id) === value) &&
          entries
            .filter((e) => String(e.id) === value)
            .map((e) => (
              <option key={e.id} value={value}>
                {e.name}
              </option>
            ))}
      </select>
      {query && (
        <small aria-live="polite">
          {matches.length
            ? `${matches.length.toLocaleString()} matches${matches.length > 100 ? ', showing the first 100' : ''}`
            : 'No directory matches. Try another spelling.'}
        </small>
      )}
    </div>
  );
}

export function AdvancedSearch({
  filters,
  directory,
  loading,
  onApply,
}: {
  filters: Filters;
  directory: Directory | null;
  loading: boolean;
  onApply: (filters: Filters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const [error, setError] = useState('');
  const change = (key: keyof Filters, value: string) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setError('');
  };
  return (
    <form
      id="advanced-search-filters"
      className="search-builder"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          (draft.min && draft.max && Number(draft.min) > Number(draft.max)) ||
          (draft.after && draft.before && draft.after > draft.before)
        ) {
          setError('The start of a range must come before its end.');
          return;
        }
        onApply(draft);
      }}
    >
      <div className="builder-heading">
        <div>
          <SlidersHorizontal size={17} />
          <h2>Refine your search</h2>
        </div>
        <span>Combine any of these filters</span>
      </div>
      <div className="builder-grid">
        <fieldset className="builder-section">
          <legend>Words & sources</legend>
          <label>
            <span>Exact phrase</span>
            <input
              value={draft.phrase}
              onChange={(e) => change('phrase', e.target.value)}
              placeholder="e.g. hilchos teshuva"
              maxLength={300}
            />
          </label>
          <label>
            <span>Exclude words</span>
            <input
              value={draft.exclude}
              onChange={(e) => change('exclude', e.target.value)}
              placeholder="e.g. parsha introduction"
              maxLength={300}
            />
            <small>Separate words with spaces.</small>
          </label>
          <label>
            <span>Search within</span>
            <select
              value={draft.scope}
              onChange={(e) => change('scope', e.target.value)}
            >
              <option value="">All available details</option>
              <option value="title">Title only</option>
            </select>
          </label>
        </fieldset>
        <fieldset className="builder-section">
          <legend>Teacher & collection</legend>
          <EntityField
            label="Teacher"
            value={draft.teacher}
            entries={directory?.teachers || []}
            onChange={(v) => change('teacher', v)}
          />
          <EntityField
            label="Topic"
            value={draft.topic}
            entries={directory?.topics || []}
            onChange={(v) => change('topic', v)}
          />
          <EntityField
            label="Series"
            value={draft.series}
            entries={directory?.series || []}
            onChange={(v) => change('series', v)}
          />
          {!directory && (
            <small>
              The directory is not available yet. You can still search by
              keywords.
            </small>
          )}
        </fieldset>
        <fieldset className="builder-section">
          <legend>Time & format</legend>
          <label>
            <span>Sort results</span>
            <select
              value={draft.sort}
              onChange={(e) => change('sort', e.target.value)}
            >
              <option value="">Default order</option>
              <option value="relevance">Best matches</option>
              <option value="popular">Most popular</option>
              <option value="library">Library order</option>
              <option value="new">Newest first</option>
              <option value="old">Oldest first</option>
              <option value="short">Shortest first</option>
              <option value="long">Longest first</option>
              <option value="title">Title A–Z</option>
            </select>
            <small>
              Most popular ranks matching shiurim by total YUTorah views.
            </small>
          </label>
          <div className="builder-range">
            <label>
              <span>Min. minutes</span>
              <input
                type="number"
                min="0"
                max="240"
                step="1"
                value={draft.min}
                onChange={(e) => change('min', e.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span>Max. minutes</span>
              <input
                type="number"
                min="0"
                max="240"
                step="1"
                value={draft.max}
                onChange={(e) => change('max', e.target.value)}
                placeholder="Any"
              />
            </label>
          </div>
          <div className="builder-range">
            <label>
              <span>From date</span>
              <input
                type="date"
                value={draft.after}
                max={draft.before || undefined}
                onChange={(e) => change('after', e.target.value)}
              />
            </label>
            <label>
              <span>Through date</span>
              <input
                type="date"
                value={draft.before}
                min={draft.after || undefined}
                onChange={(e) => change('before', e.target.value)}
              />
            </label>
          </div>
          <label>
            <span>Language</span>
            <select
              value={draft.language}
              onChange={(e) => change('language', e.target.value)}
            >
              <option value="">Any language</option>
              <option value="EN">English</option>
              <option value="HE">Hebrew</option>
            </select>
          </label>
          <label>
            <span>Format</span>
            <select
              value={draft.format}
              onChange={(e) => change('format', e.target.value)}
            >
              <option value="">All formats</option>
              <option value="audio">Audio</option>
              <option value="video">Video</option>
              <option value="text">Articles</option>
            </select>
          </label>
        </fieldset>
      </div>
      {error && (
        <p className="builder-error" role="alert">
          {error}
        </p>
      )}
      <div className="builder-footer">
        <p>
          Tip: use &quot;exact phrases&quot; and -words in the search bar, too.
        </p>
        <div>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraft({ ...noFilters });
              setError('');
            }}
          >
            Reset fields
          </button>
          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? 'Searching…' : 'Apply & search'}
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </form>
  );
}
