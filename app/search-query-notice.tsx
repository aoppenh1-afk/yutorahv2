'use client';

import type { SearchResult } from '@/lib/yutorah';
import { resolvedSearchFilters, type Filters } from '@/lib/search-filters';

export function SearchQueryNotice({
  result,
  onSearch,
}: {
  result: SearchResult;
  onSearch: (query: string, filters: Filters) => void;
}) {
  const original = result.plan.original.trim();
  if (!original) return null;
  const filters = resolvedSearchFilters(result.plan);
  return (
    <div className="search-query-notice" aria-live="polite">
      <p>
        Showing results for{' '}
        <strong dir="auto">{result.correction || original}</strong>.
        {result.plan.literal && <span> Exact wording.</span>}
      </p>
      {result.suggestion && (
        <p>
          Did you mean{' '}
          <button
            className="text-button"
            onClick={() =>
              onSearch(result.suggestion!, { ...filters, literal: '' })
            }
          >
            {result.suggestion}
          </button>
          ?
        </p>
      )}
      {result.correction && (
        <button
          className="text-button"
          onClick={() => onSearch(original, { ...filters, literal: '1' })}
        >
          Search instead for <span dir="auto">{original}</span>
        </button>
      )}
    </div>
  );
}
