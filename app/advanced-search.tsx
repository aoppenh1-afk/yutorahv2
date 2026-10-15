'use client';
import { useState, useEffect } from 'react';
import { ArrowRight, SlidersHorizontal } from 'lucide-react';
import type { CatalogFacets } from '@/lib/catalog';
import type { SearchResult } from '@/lib/yutorah';
import type { Directory } from '@/lib/yutorah';
import { searchText } from '@/lib/search-discovery';

import { noFilters, type Filters } from '@/lib/search-filters';
export { noFilters, type Filters } from '@/lib/search-filters';

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
    <details className="advanced-entity compact-entity">
      <summary>
        <span>{label}</span>
        <strong>
          {entries.find((e) => String(e.id) === value)?.name ||
            (value
              ? `Selected ${label.toLowerCase()}`
              : `Any ${label.toLowerCase()}`)}
        </strong>
      </summary>
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
    </details>
  );
}

export function AdvancedSearch({
  filters,
  directory,
  loading,
  results,
  onApply,
}: {
  filters: Filters;
  directory: Directory | null;
  loading: boolean;
  results?: SearchResult | null;
  onApply: (filters: Filters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<CatalogFacets | null>(null),
    [catalogError, setCatalogError] = useState(''),
    [catalogRetry, setCatalogRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setCatalogError('');
    fetch('/api/catalog?action=facets', { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('Additional directories could not load.');
        return r.json();
      })
      .then((d) => {
        if (!abort.signal.aborted) setCatalog(d);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setCatalogError(e.message);
      });
    return () => abort.abort();
  }, [catalogRetry]);
  const active = results?.complete === true;
  const entries = (key: keyof CatalogFacets) =>
    (active
      ? results?.facets[key] || []
      : catalog?.[key] ||
        (key === 'teachers'
          ? directory?.teachers
          : key === 'series'
            ? directory?.series
            : key === 'topics'
              ? directory?.topics
              : []) ||
        []
    ).map((e) => {
      const canonical =
        key === 'teachers'
          ? directory?.teachers.find((t) => t.id === e.id)
          : key === 'series'
            ? directory?.series.find((t) => t.id === e.id)
            : key === 'topics'
              ? directory?.topics.find((t) => t.id === e.id)
              : null;
      return {
        ...e,
        name:
          canonical && 'path' in canonical
            ? canonical.path?.join(' / ') || canonical.name
            : canonical?.name || e.name,
      };
    });

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
          (draft.after && draft.before && draft.after > draft.before) ||
          (draft.uploadedAfter &&
            draft.uploadedBefore &&
            draft.uploadedAfter > draft.uploadedBefore)
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
      <p className="facet-provenance">
        {active
          ? 'Counts reflect the current result set.'
          : results?.complete === false
            ? 'Directory counts are shown while the search finishes.'
            : 'Counts reflect the full library.'}
      </p>
      <div className="builder-grid compact-builder">
        <fieldset className="builder-section">
          <legend>Teacher, subject & collection</legend>
          {(
            [
              ['teacher', 'Teacher', 'teachers'],
              ['topic', 'Topic', 'topics'],
              ['series', 'Series', 'series'],
              ['collection', 'Collection', 'collections'],
              ['venue', 'Venue', 'venues'],
            ] as const
          ).map(([key, label, field]) => (
            <EntityField
              key={key}
              label={label}
              value={draft[key]}
              entries={entries(field)}
              onChange={(v) => change(key, v)}
            />
          ))}
          {catalogError && (
            <output>
              {catalogError}{' '}
              <button
                type="button"
                className="text-button"
                onClick={() => setCatalogRetry((n) => n + 1)}
              >
                Retry
              </button>
            </output>
          )}
          <details className="builder-disclosure">
            <summary>Subject group</summary>
            <label>
              <span>Subject group</span>
              <select
                value={draft.group}
                onChange={(e) => change('group', e.target.value)}
              >
                <option value="">Any subject group</option>
                {[...new Set(directory?.topics.map((t) => t.group) || [])]
                  .sort()
                  .map((g) => (
                    <option key={g}>{g}</option>
                  ))}
              </select>
            </label>
          </details>
          <details
            className="builder-disclosure"
            open={!!(draft.phrase || draft.exclude || draft.scope)}
          >
            <summary>Words & sources</summary>
            <label>
              <span>Exact phrase</span>
              <input
                value={draft.phrase}
                onChange={(e) => change('phrase', e.target.value)}
                maxLength={300}
                placeholder="e.g. hilchos teshuva"
              />
            </label>
            <label>
              <span>Exclude words</span>
              <input
                value={draft.exclude}
                onChange={(e) => change('exclude', e.target.value)}
                maxLength={300}
                placeholder="Separate words with spaces"
              />
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
          </details>
          <label className="notes-availability-filter">
            <input
              type="checkbox"
              checked={draft.notesOnly === '1'}
              onChange={(e) => change('notesOnly', e.target.checked ? '1' : '')}
            />
            <span>Written notes available</span>
          </label>
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
          </label>
          <div className="builder-range">
            <label>
              <span>Min. minutes</span>
              <input
                type="number"
                min="0"
                max="240"
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
                value={draft.max}
                onChange={(e) => change('max', e.target.value)}
                placeholder="Any"
              />
            </label>
          </div>
          <label>
            <span>Date to use</span>
            <select
              value={draft.dateBasis}
              onChange={(e) => change('dateBasis', e.target.value)}
            >
              <option value="">Lecture date</option>
              <option value="uploaded">Upload date</option>
            </select>
            <small>
              {draft.dateBasis === 'uploaded'
                ? 'Includes older shiurim newly added to the library. Upload dates use New York time.'
                : 'When the shiur was given.'}
            </small>
          </label>
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
          {(draft.dateBasis !== 'uploaded' ||
            draft.uploadedAfter ||
            draft.uploadedBefore) && (
            <details
              className="builder-disclosure"
              open={!!(draft.uploadedAfter || draft.uploadedBefore)}
            >
              <summary>Also limit upload dates</summary>
              <div className="builder-range">
                <label>
                  <span>Uploaded from</span>
                  <input
                    type="date"
                    value={draft.uploadedAfter}
                    max={draft.uploadedBefore || undefined}
                    onChange={(e) => change('uploadedAfter', e.target.value)}
                  />
                </label>
                <label>
                  <span>Uploaded through</span>
                  <input
                    type="date"
                    value={draft.uploadedBefore}
                    min={draft.uploadedAfter || undefined}
                    onChange={(e) => change('uploadedBefore', e.target.value)}
                  />
                </label>
              </div>
            </details>
          )}
          <div className="builder-range">
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
          </div>
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
              setDraft({ ...noFilters, resolved: filters.resolved });
              setError('');
            }}
          >
            Reset fields
          </button>
          <button type="submit" className="primary-button">
            {loading ? 'Apply new filters' : 'Apply & search'}
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </form>
  );
}
