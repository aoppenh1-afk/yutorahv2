'use client';
import { Library, AudioLines } from 'lucide-react';

export type SearchScopeValue = 'shiurim' | 'inside';
export default function SearchScope({
  value,
  count,
  onChange,
}: {
  value: SearchScopeValue;
  count?: number;
  onChange: (value: SearchScopeValue) => void;
}) {
  return (
    <div className="search-scope" aria-label="What to search">
      {(
        [
          ['shiurim', 'Shiurim', Library],
          ['inside', 'Inside the Shiur', AudioLines],
        ] as const
      ).map(([scope, label, Icon]) => (
        <button
          key={scope}
          aria-pressed={value === scope}
          onClick={() => {
            const url = new URL(window.location.href);
            if (scope === 'shiurim') url.searchParams.delete('searchIn');
            else url.searchParams.set('searchIn', scope);
            window.history.replaceState({}, '', url);
            onChange(scope);
          }}
        >
          <Icon size={16} />
          {label}
          {scope === 'shiurim' && value === scope && count !== undefined && (
            <span>{count.toLocaleString()}</span>
          )}
        </button>
      ))}
    </div>
  );
}
