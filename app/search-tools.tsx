'use client';
import { useMemo } from 'react';
import { Clock3, Headphones, Sparkles } from 'lucide-react';

import { parseSearch, type Directory } from '@/lib/yutorah';
import type { Filters } from '@/lib/search-filters';

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
