'use client';
import { useEffect, useRef, useState } from 'react';
import {
  invalidateCatalogResource,
  loadCatalogResource,
} from '@/lib/catalog-client';
import type { CatalogSearchResult } from '@/lib/search-results';

const empty: CatalogSearchResult = {
  items: [],
  total: 0,
  next: null,
  partial: false,
};
const urlFor = (query: string, offset = 0) =>
  '/api/catalog?' +
  new URLSearchParams({ action: 'search', q: query, offset: String(offset) });
async function read(query: string, signal: AbortSignal, offset = 0) {
  const data = await loadCatalogResource<CatalogSearchResult>(
    urlFor(query, offset),
    signal,
  );
  if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total))
    throw new Error('Invalid library search response.');
  return data;
}
type State = {
  query: string;
  data: CatalogSearchResult;
  status: 'loading' | 'ready' | 'error';
};

export function useCatalogSearch(query: string, enabled: boolean) {
  query = query.trim();
  enabled = enabled && query.length >= 2;
  const [state, setState] = useState<State | null>(null);
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const active = new AbortController();
    controller.current = active;
    setState({ query, data: empty, status: 'loading' });
    read(query, active.signal)
      .then((data) => {
        if (!active.signal.aborted) setState({ query, data, status: 'ready' });
      })
      .catch(() => {
        if (!active.signal.aborted)
          setState({ query, data: empty, status: 'error' });
      });
    return () => active.abort();
  }, [query, enabled, attempt]);
  const current = enabled && state?.query === query ? state : null;
  const loadMore = async () => {
    const next = current?.data.next;
    const active = controller.current;
    if (
      !current ||
      next == null ||
      !active ||
      active.signal.aborted ||
      current?.status === 'loading'
    )
      return;
    setState({ ...current, status: 'loading' });
    try {
      const data = await read(query, active.signal, next);
      if (!active.signal.aborted)
        setState({
          query,
          status: 'ready',
          data: {
            ...data,
            items: [
              ...new Map(
                [...current.data.items, ...data.items].map((item) => [
                  `${item.kind}-${item.id}`,
                  item,
                ]),
              ).values(),
            ],
          },
        });
    } catch {
      if (!active.signal.aborted) setState({ ...current, status: 'error' });
    }
  };
  return {
    ...(current?.data || empty),
    status: enabled ? current?.status || 'loading' : 'idle',
    loadMore,
    retry: () => {
      invalidateCatalogResource(urlFor(query));
      setAttempt((value) => value + 1);
    },
  };
}
