'use client';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { SearchResult, Shiur } from '@/lib/yutorah';
import { loadTeacherPopularity } from '@/lib/teacher-popularity-client';
import { StatePanel } from './ui';

export function TeacherPopularShiurim({
  teacherId,
  rows,
}: {
  teacherId: number;
  rows: (items: Shiur[]) => React.ReactNode;
}) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError('');
    void loadTeacherPopularity(teacherId, controller.signal, setResult).catch(
      (e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Please try again.');
      },
    );
    return () => controller.abort();
  }, [teacherId, retry]);
  return (
    <>
      {error ? (
        <StatePanel
          title="Most viewed shiurim could not load"
          description={error}
          action="Try again"
          onAction={() => setRetry((n) => n + 1)}
        />
      ) : !result ? (
        <output className="catalog-loading">
          <Loader2 size={17} className="spin" /> Loading most viewed shiurim…
        </output>
      ) : (
        <div className="catalog-popularity-status">
          {result.complete ? (
            <p>Ranked by total views across this teacher&apos;s shiurim.</p>
          ) : result.sourceTotal ? (
            <>
              <output>
                <Loader2 size={14} className="spin" /> Checking{' '}
                {(result.scanned || 0).toLocaleString()} of{' '}
                {(result.sourceTotal || 0).toLocaleString()} shiurim. Rankings
                update until the full archive is checked.
              </output>
              <progress
                aria-label="Teacher ranking progress"
                value={result.scanned || 0}
                max={Math.max(1, result.sourceTotal || 0)}
              />
            </>
          ) : (
            <output>
              <Loader2 size={14} className="spin" /> Preparing teacher ranking…
            </output>
          )}
        </div>
      )}
      {result && rows(result.items)}
      {result?.complete && result.items.length === 0 && !error && (
        <StatePanel title="No shiurim found for this teacher" />
      )}
    </>
  );
}
