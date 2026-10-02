'use client';

import { Check, ChevronDown } from 'lucide-react';
import type { SearchResult } from '@/lib/yutorah';

export function MobileSearchSummary({
  result,
  searching,
  onToggle,
}: {
  result: SearchResult;
  searching: boolean;
  onToggle: () => void;
}) {
  const partial = result.complete === false;
  const count =
    result.filtered && !partial ? result.items.length : result.total;
  const label = partial ? 'matches' : result.filtered ? 'loaded' : 'shiurim';
  if (result.complete === undefined && !result.filtered) {
    return (
      <h2 className="mobile-result-count">
        {count.toLocaleString()} {label}
      </h2>
    );
  }
  return (
    <div className="mobile-result-status">
      <details className="mobile-result-details">
        <summary>
          <span className="mobile-result-count">
            <strong>{count.toLocaleString()}</strong> {label}
          </span>
          <span className="mobile-result-state">
            {partial ? (
              <span
                className={
                  searching
                    ? 'search-status-dot is-updating'
                    : 'search-status-dot'
                }
              />
            ) : result.complete ? (
              <Check size={14} />
            ) : null}
            {partial
              ? searching
                ? 'Updating'
                : 'Paused'
              : result.complete
                ? 'Complete'
                : 'Details'}
            <ChevronDown size={14} />
          </span>
        </summary>
        <div className="mobile-result-status-body">
          <p>
            {result.complete === undefined
              ? `Filtered from ${result.total.toLocaleString()} library matches. ${result.nextPage ? 'Load more to continue.' : 'All matches checked.'}`
              : result.complete
                ? `${result.sourceTotal !== undefined ? `All ${result.sourceTotal.toLocaleString()} library candidates checked.` : 'Available library results checked.'} ${result.total.toLocaleString()} matches.`
                : `${result.scanned !== undefined && result.sourceTotal !== undefined ? `Checking ${result.scanned.toLocaleString()} of ${result.sourceTotal.toLocaleString()} shiurim.` : 'Checking the library for more matches.'} Counts and order are provisional until complete.`}
          </p>
          {partial && (
            <button className="text-button" onClick={onToggle}>
              {searching ? 'Pause search' : 'Continue search'}
            </button>
          )}
        </div>
      </details>
      {partial && (
        <progress
          className="mobile-search-progress-bar"
          aria-label="Search progress"
          value={result.scanned || 0}
          max={result.sourceTotal || 1}
        />
      )}
    </div>
  );
}
