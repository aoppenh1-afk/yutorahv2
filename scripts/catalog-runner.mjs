import { setTimeout as pause } from 'node:timers/promises';

const transient = new Set([408, 429, 500, 502, 503, 504]);

function retryDelay(header, attempt, now) {
  const requested =
    header && /^\d+$/.test(header)
      ? Number(header) * 1000
      : header
        ? Date.parse(header) - now
        : 0;
  return Math.min(
    60000,
    Math.max(1000 * 2 ** attempt, Number.isFinite(requested) ? requested : 0),
  );
}

/** Refresh independent resources, retrying temporary failures within one shared budget. */
export async function runCatalogWarm({
  base,
  token,
  collections,
  teachers,
  maxRuntimeMs,
  fetcher = fetch,
  now = Date.now,
  wait = pause,
  report = () => {},
}) {
  const deadline = now() + maxRuntimeMs;
  const result = { warmed: 0, partial: 0, pending: 0, budgetReached: false };
  async function read(params) {
    const url = new URL('/api/catalog/refresh', base);
    url.search = new URLSearchParams(params).toString();
    for (let attempt = 0; ; attempt++) {
      if (now() >= deadline - 1000) return null;
      let response;
      let reason = 'network';
      try {
        response = await fetcher(url, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          redirect: 'error',
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(60000, deadline - now())),
          ),
        });
      } catch {
        // Provider exception strings can contain request headers or credentials.
      }
      if (response?.ok) return response.json();
      const retryAfter = response?.headers.get('Retry-After');
      if (response) {
        reason = 'http-' + response.status;
        await response.body?.cancel();
        if (!transient.has(response.status)) throw new Error(reason);
      }
      if (attempt >= 3) throw new Error(reason);
      const delay = retryDelay(retryAfter, attempt, now());
      report({ ...params, status: 'retrying', reason, attempt: attempt + 1 });
      if (now() + delay >= deadline - 1000) return null;
      await wait(delay);
    }
  }
  const plan = await read({ kind: 'plan' });
  if (!plan) return { ...result, budgetReached: true };
  if (!Array.isArray(plan.collections) || !Array.isArray(plan.teachers))
    throw new Error('Invalid catalog refresh plan.');
  const queue = [
    ...plan.collections
      .slice(0, collections)
      .map((id) => ({ kind: 'collection', id: String(id) })),
    ...plan.teachers
      .slice(0, teachers)
      .map((id) => ({ kind: 'teacher', id: String(id) })),
  ];
  while (queue.length && now() < deadline - 1000) {
    const task = queue.shift();
    try {
      const response = await read(task);
      if (response === null) {
        queue.unshift(task);
        result.budgetReached = true;
        break;
      }
      if (typeof response.complete !== 'boolean')
        throw new Error('Invalid catalog refresh response.');
      if (response?.complete === true) result.warmed++;
      else queue.push(task);
    } catch (error) {
      result.partial++;
      report({
        ...task,
        status: 'failed',
        reason: /^http-\d+$|^network$/.test(error.message)
          ? error.message
          : 'invalid-response',
      });
    }
    if (now() < deadline - 1000) await wait(100);
  }
  result.pending = queue.length;
  result.budgetReached ||= now() >= deadline - 1000;
  return result;
}
