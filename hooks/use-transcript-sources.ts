'use client';
import { useEffect, useState } from 'react';
import { pollDelay } from '@/lib/poll-delay';
import { sourceRequest, sourceRetryDelay } from '@/lib/source-request';
import type { SourcesResult } from '@/lib/sources';
export function useTranscriptSources(
  shiurId: number,
  transcriptId: string | undefined,
  enabled: boolean,
  version?: string,
) {
  const identity = `${shiurId}:${transcriptId ?? ''}:${version ?? ''}`;
  const [loaded, setLoaded] = useState<{
    identity: string;
    result: SourcesResult;
  } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    setLoaded(null);
    setError('');
    setRecovering(false);
    if (!enabled || !transcriptId) return;
    const abort = new AbortController();
    let polls = 0;
    const read = async () => {
      try {
        const response = await sourceRequest(
          `/api/sources?id=${shiurId}&revision=${encodeURIComponent(transcriptId)}${version ? '&version=' + encodeURIComponent(version) : ''}`,
          abort.signal,
          {
            onRetry: () => {
              if (!abort.signal.aborted) setRecovering(true);
            },
          },
        );
        const data = (await response.json()) as SourcesResult & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || 'Sources are temporarily unavailable.');
        if (data.transcriptId !== transcriptId)
          throw new Error(
            'The transcript has changed. Refresh the transcript to check its sources.',
          );
        if (abort.signal.aborted) return;
        setLoaded({ identity, result: data });
        setRecovering(false);
        if (data.status === 'pending') {
          if (++polls >= 300)
            throw new Error(
              'Sources are still being checked. Retry to continue.',
            );
          await pollDelay(
            sourceRetryDelay(response.headers.get('Retry-After')),
            abort.signal,
          );
          if (!abort.signal.aborted) void read();
        }
      } catch (error) {
        if (!abort.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : 'Sources are temporarily unavailable.',
          );
      }
    };
    void read();
    return () => {
      abort.abort();
    };
  }, [shiurId, transcriptId, enabled, retry, version, identity]);
  return {
    result: loaded?.identity === identity ? loaded.result : null,
    error,
    recovering,
    retry: () => setRetry((n) => n + 1),
  };
}
