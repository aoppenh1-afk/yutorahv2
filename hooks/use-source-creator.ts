'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceCreatorResult } from '@/lib/source-creator';
import type { SourceFeatures } from '@/lib/source-features';
import { sourceRequest, sourceRetryDelay } from '@/lib/source-request';
import { pollDelay } from '@/lib/poll-delay';

const preferenceKey = 'yutorah:source-outputs:v1';
export function useSourceCreator(options: {
  shiurId: number;
  transcriptId?: string;
  version?: string;
  source?: 'official-yutorah';
  enabled: boolean;
  onRevisionChange: () => void;
}) {
  const [available, setAvailable] = useState<SourceFeatures>({
    links: false,
    sheets: false,
  });
  const [preferences, setPreferences] = useState<SourceFeatures>({
    links: true,
    sheets: true,
  });
  const [configured, setConfigured] = useState(false);
  const [configError, setConfigError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    identity: string;
    result: SourceCreatorResult;
  } | null>(null);
  const [error, setError] = useState('');
  const [recovering, setRecovering] = useState(false);
  const onRevisionChange = useRef(options.onRevisionChange);
  onRevisionChange.current = options.onRevisionChange;
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
      if (
        stored &&
        typeof stored.links === 'boolean' &&
        typeof stored.sheets === 'boolean'
      )
        setPreferences(stored);
    } catch {
      /* A storage failure does not prevent source creation. */
    }
  }, []);
  useEffect(() => {
    if (!options.enabled) return;
    const abort = new AbortController();
    setConfigError('');
    void sourceRequest('/api/source-creator/features', abort.signal)
      .then((response) => response.json())
      .then((features) => {
        if (abort.signal.aborted) return;
        if (
          typeof features.links !== 'boolean' ||
          typeof features.sheets !== 'boolean'
        )
          throw new Error('Source settings could not be loaded.');
        setAvailable(features);
        setConfigured(true);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setConfigError(
            'Source settings could not be loaded. Retry to continue.',
          );
      });
    return () => abort.abort();
  }, [options.enabled, attempt]);
  const features = {
    links: available.links && preferences.links,
    sheets: available.sheets && preferences.sheets,
  };
  const identity = `${options.shiurId}:${options.transcriptId || ''}:${options.version || ''}:${options.source || ''}`;
  const running =
    options.enabled && configured && (features.links || features.sheets);
  useEffect(() => {
    setError('');
    setRecovering(false);
    if (!running) return;
    const abort = new AbortController();
    let pendingPasses = 0;
    const read = async () => {
      let fresh = attempt > 0;
      while (!abort.signal.aborted) {
        if (document.hidden) {
          await pollDelay(2000, abort.signal);
          continue;
        }
        const query = new URLSearchParams({ id: String(options.shiurId) });
        if (options.transcriptId) query.set('revision', options.transcriptId);
        if (options.version) query.set('version', options.version);
        if (options.source) query.set('source', options.source);
        if (fresh) {
          query.set('refresh', '1');
          fresh = false;
        }
        const response = await sourceRequest(
          `/api/source-creator?${query}`,
          abort.signal,
          {
            onRetry: () => {
              if (!abort.signal.aborted) setRecovering(true);
            },
          },
        );
        const result = (await response.json()) as SourceCreatorResult;
        if (abort.signal.aborted) return;
        if (
          options.transcriptId &&
          result.transcriptId !== options.transcriptId
        )
          throw new Error(
            'The transcript has changed. Refresh to check its sources.',
          );
        setLoaded({ identity, result });
        setRecovering(false);
        if (result.status === 'pending') {
          if (++pendingPasses > 450)
            throw new Error(
              'Source checking is taking longer than expected. Retry to continue.',
            );
          await pollDelay(
            result.waiting === false
              ? 150
              : sourceRetryDelay(response.headers.get('Retry-After')),
            abort.signal,
          );
        } else {
          pendingPasses = 0;
          // Refresh growing transcripts; also discover notes published after the first scan.
          await pollDelay(
            result.transcriptComplete ? 60000 : 15000,
            abort.signal,
          );
          fresh = true;
        }
      }
    };
    void read().catch((failure: unknown) => {
      if (abort.signal.aborted) return;
      if (
        failure &&
        typeof failure === 'object' &&
        'status' in failure &&
        failure.status === 409
      ) {
        setError(
          'The transcript has changed. Refreshing its text and sources…',
        );
        onRevisionChange.current();
      } else
        setError(
          failure instanceof Error
            ? failure.message
            : 'Source checking was interrupted. Retry to continue.',
        );
    });
    return () => abort.abort();
  }, [
    running,
    identity,
    options.shiurId,
    options.transcriptId,
    options.version,
    options.source,
    attempt,
  ]);
  const setOutput = useCallback(
    (name: keyof SourceFeatures, value: boolean) => {
      setPreferences((previous) => {
        const next = { ...previous, [name]: value };
        try {
          localStorage.setItem(preferenceKey, JSON.stringify(next));
        } catch {
          /* Session settings still work. */
        }
        return next;
      });
    },
    [],
  );
  return {
    result: loaded?.identity === identity ? loaded.result : null,
    error: configError || error,
    recovering,
    features,
    available,
    configured,
    setOutput,
    retry: () => setAttempt((n) => n + 1),
  };
}
