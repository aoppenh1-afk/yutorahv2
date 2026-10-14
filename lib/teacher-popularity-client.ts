import type { SearchResult } from './yutorah';
import { pollDelay } from './poll-delay';

/** Rank the full teacher archive, continuing the existing search index. */
export async function loadTeacherPopularity(
  teacherId: number,
  signal: AbortSignal,
  onResult: (result: SearchResult) => void,
): Promise<void> {
  const params = new URLSearchParams({
    q: '',
    teacher: String(teacherId),
    sort: 'popular',
    page: '1',
  });
  while (!signal.aborted) {
    const response = await fetch('/api/search?' + params, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
    });
    const result = (await response.json()) as SearchResult & { error?: string };
    if (!response.ok)
      throw new Error(result.error || 'Most viewed shiurim could not load.');
    if (signal.aborted) return;
    onResult(result);
    if (result.complete) return;
    // A concurrent request may still be creating the shared run.
    if (result.run) params.set('run', result.run);
    await pollDelay(result.retryAfterMs || 1500, signal);
  }
}
