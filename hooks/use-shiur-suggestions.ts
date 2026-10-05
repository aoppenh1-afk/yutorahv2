'use client';
import { useEffect, useState } from 'react';
import type { ShiurSuggestion } from '@/lib/search-discovery';

const cache = new Map<string, { until: number; items: ShiurSuggestion[] }>();
type Result = {
  query: string;
  items: ShiurSuggestion[];
  status: 'loading' | 'ready' | 'error';
};

export function useShiurSuggestions(value: string, open: boolean) {
  const query = value.trim().toLowerCase();
  const [result, setResult] = useState<Result | null>(null);
  const enabled = open && query.length >= 3;
  useEffect(() => {
    if (!enabled) return;
    const cached = cache.get(query);
    if (cached && cached.until > Date.now()) {
      setResult({ query, items: cached.items, status: 'ready' });
      return;
    }
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(async () => {
      setResult({ query, items: [], status: 'loading' });
      deadline = setTimeout(() => {
        setResult({ query, items: [], status: 'error' });
        controller.abort();
      }, 3000);
      try {
        const response = await fetch(
          '/api/suggestions?' + new URLSearchParams({ q: query }),
          {
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('Suggestions are unavailable.');
        const body = (await response.json()) as { items: ShiurSuggestion[] };
        if (!Array.isArray(body.items)) throw new Error('Invalid suggestions.');
        if (controller.signal.aborted) return;
        const items = body.items.slice(0, 5);
        if (cache.size >= 25 && !cache.has(query))
          cache.delete(cache.keys().next().value!);
        cache.set(query, { until: Date.now() + 60000, items });
        setResult({ query, items, status: 'ready' });
      } catch {
        if (!controller.signal.aborted)
          setResult({ query, items: [], status: 'error' });
      } finally {
        clearTimeout(deadline);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      controller.abort();
    };
  }, [query, enabled]);
  // Query tags hide stale results even before effect cleanup runs on a new edit.
  const current = enabled && result?.query === query ? result : null;
  return {
    items: current?.items || [],
    status: enabled ? current?.status || 'loading' : 'idle',
  };
}
