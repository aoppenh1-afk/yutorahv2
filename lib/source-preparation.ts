import { sourceDescription } from './source-description';
import type { SearchDatabase } from './search-storage';
import {
  sourceCreatorPolicy,
  type SourceCreatorResult,
} from './source-creator';
import { sourceCreatorResponse } from './source-creator-handler';
import { pruneSourceCache } from './sources-cache';
import { sourceRetryDelay } from './source-request';
import type { SourceFeatures } from './source-features';

const prefix = `preparation:${sourceCreatorPolicy}:`;
const lockKey = 'preparation:runner-lock';
const retention = 365 * 86400_000;
type Row = { id: string; payload: string; lease: number };
type Job = {
  id: string;
  checkedAt?: number;
  status: string;
  attempts?: number;
};
type Inventory = { page: number; total?: number; checkedAt?: number };
export type PreparationReport = {
  outcome:
    | 'finished'
    | 'budget'
    | 'locked'
    | 'disabled'
    | 'upstream-unavailable';
  discovered: number;
  processed: number;
  ready: number;
  missing: number;
  deferred: number;
  nextPage: number;
  discoveryFailed: boolean;
};
type PreparationOptions = {
  db: SearchDatabase;
  site: URL;
  signal: AbortSignal;
  maxRuntimeMs?: number;
  maxJobs?: number;
  catalogPages?: number;
  ids?: string[];
  features?: SourceFeatures;
  fetcher?: typeof fetch;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  report?: (event: { id?: string; status: string; sources?: number }) => void;
};
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });

/** Bounded response reads apply to catalog and published inputs alike. */
export async function preparationFetch(
  url: URL,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  if (reader)
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 8_000_000) {
          await reader.cancel();
          throw new Error('Published input exceeded its size limit.');
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return new Response(data, {
    status: response.status,
    headers: response.headers,
  });
}

export async function preparationCatalog(
  page: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL('https://yutorah.org/api/search/get');
  url.search = new URLSearchParams({
    searchTerm: '',
    getFacets: 'false',
    start: String(page),
  }).toString();
  const response = await preparationFetch(url, signal, fetcher);
  if (!response.ok) throw new Error('Catalog unavailable.');
  const raw = await response.json();
  const body = raw.response ?? raw;
  const total = Number(body.numFound ?? body.total ?? body.totalRecords);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Array.isArray(body.docs) ||
    body.docs.length !== Math.max(0, Math.min(30, total - (page - 1) * 30))
  )
    throw new Error('Incomplete catalog page.');
  const ids: string[] = body.docs.map((doc: Record<string, unknown>) => {
    const value = doc.shiurID ?? doc.shiurid;
    const id = String(Array.isArray(value) ? value[0] : value);
    if (!/^[1-9]\d{0,11}$/.test(id)) throw new Error('Invalid catalog ID.');
    return id;
  });
  if (new Set(ids).size !== ids.length)
    throw new Error('Duplicate catalog IDs.');
  return { ids, total };
}

/** Runs the existing detector locally. Only published inputs come from the site. */
export async function runSourcePreparation(
  options: PreparationOptions,
): Promise<PreparationReport> {
  const { db, signal } = options;
  const now = options.now || Date.now;
  const wait = options.wait || sleep;
  const fetcher = options.fetcher || fetch;
  const maxRuntimeMs = options.maxRuntimeMs ?? 20 * 60000;
  const maxJobs = options.maxJobs ?? 60;
  const pages = options.catalogPages ?? 2;
  const ids = options.ids || [];
  if (
    !Number.isInteger(maxRuntimeMs) ||
    maxRuntimeMs < 1000 ||
    maxRuntimeMs > 25 * 60000 ||
    !Number.isInteger(maxJobs) ||
    maxJobs < 1 ||
    maxJobs > 500 ||
    !Number.isInteger(pages) ||
    pages < 0 ||
    pages > 20 ||
    ids.length > 100 ||
    ids.some((id) => !/^[1-9]\d{0,11}$/.test(id)) ||
    options.site.username ||
    options.site.password ||
    !(
      options.site.protocol === 'https:' ||
      (options.site.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(options.site.hostname))
    )
  )
    throw new Error('Invalid source preparation options.');
  const summary: PreparationReport = {
    outcome: 'finished',
    discovered: 0,
    processed: 0,
    ready: 0,
    missing: 0,
    deferred: 0,
    nextPage: 1,
    discoveryFailed: false,
  };
  // Server switches apply here too, including when this runs outside the web server.
  let features = options.features;
  if (!features) {
    const response = await preparationFetch(
      new URL('/api/source-creator/features', options.site),
      signal,
      fetcher,
    );
    if (!response.ok)
      throw new Error(
        'Source settings unavailable. Deploy the source creator before enabling preparation.',
      );
    const configured = await response.json();
    if (
      typeof configured.links !== 'boolean' ||
      typeof configured.sheets !== 'boolean'
    )
      throw new Error('Invalid source settings.');
    features = configured;
  }
  if (!features!.links && !features!.sheets)
    return { ...summary, outcome: 'disabled' };
  const started = now();
  const deadline = started + maxRuntimeMs;
  const lease = deadline + 60000;
  await db
    .prepare(
      'INSERT INTO sources_runs(id,payload,lease,expires) VALUES(?,?,0,?) ON CONFLICT(id) DO NOTHING',
    )
    .bind(lockKey, '{}', started + retention)
    .run();
  const claimed = await db
    .prepare('UPDATE sources_runs SET lease=?,expires=? WHERE id=? AND lease<?')
    .bind(lease, started + retention, lockKey, started)
    .run();
  if (!claimed.meta.changes) return { ...summary, outcome: 'locked' };
  const active = () => !signal.aborted && now() < deadline;
  const save = async (
    key: string,
    value: unknown,
    next = 0,
    insertOnly = false,
  ) => {
    const update = insertOnly
      ? 'NOTHING'
      : 'UPDATE SET payload=excluded.payload,lease=excluded.lease,expires=excluded.expires';
    const result = await db
      .prepare(
        `INSERT INTO sources_runs(id,payload,lease,expires) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM sources_runs WHERE id=? AND lease=? AND lease>?) ON CONFLICT(id) DO ${update}`,
      )
      .bind(
        key,
        JSON.stringify(value),
        next,
        now() + retention,
        lockKey,
        lease,
        now(),
      )
      .run();
    if (!insertOnly && !result.meta.changes)
      throw new Error('Preparation ownership changed.');
  };
  const enqueue = async (id: string, force = false, priority = 0) => {
    await save(
      prefix + 'job:' + id,
      { id, status: 'queued' },
      priority,
      !force,
    );
    summary.discovered++;
  };
  try {
    await pruneSourceCache(db);
    for (const id of ids) await enqueue(id, true, -2);
    const row = await db
      .prepare('SELECT payload FROM sources_runs WHERE id=?')
      .bind(prefix + 'inventory')
      .first<{ payload: string }>();
    let inventory: Inventory = row ? JSON.parse(row.payload) : { page: 1 };
    summary.nextPage = inventory.page;
    // Refresh new uploads every run while an independent cursor traverses older pages.
    if (pages && active())
      try {
        const recent = await preparationCatalog(1, signal, fetcher);
        for (const id of recent.ids) await enqueue(id, false, -1);
        if (inventory.page === 1 || (inventory.page - 1) * 30 >= recent.total) {
          inventory = {
            page: recent.total > 30 ? 2 : 1,
            total: recent.total,
            checkedAt: now(),
          };
          await save(prefix + 'inventory', inventory);
        }
        for (let pass = 1; pass < pages && active(); pass++) {
          const page = await preparationCatalog(
            inventory.page,
            signal,
            fetcher,
          );
          for (const id of page.ids) await enqueue(id);
          inventory = {
            page: inventory.page * 30 >= page.total ? 1 : inventory.page + 1,
            total: page.total,
            checkedAt: now(),
          };
          await save(prefix + 'inventory', inventory);
        }
        summary.nextPage = inventory.page;
      } catch {
        if (signal.aborted) throw signal.reason;
        summary.discoveryFailed = true;
        options.report?.({ status: 'catalog_deferred' });
      }
    let consecutiveFailures = 0;
    for (let n = 0; n < maxJobs && active(); n++) {
      // Reserve every fourth attempt for due rechecks so a large archive backlog
      // cannot indefinitely delay newly published notes or corrected transcripts.
      const recheckOrder =
        n % 4 === 3 ? 'CASE WHEN lease>0 THEN 0 ELSE 1 END,' : '';
      const row = await db
        .prepare(
          `SELECT id,payload,lease FROM sources_runs WHERE id LIKE ? AND lease<=? ORDER BY ${recheckOrder}lease,id LIMIT 1`,
        )
        .bind(prefix + 'job:%', now())
        .first<Row>();
      if (!row) break;
      const job = JSON.parse(row.payload) as Job;
      if (
        !/^[1-9]\d{0,11}$/.test(job.id) ||
        row.id !== prefix + 'job:' + job.id
      )
        throw new Error('Invalid saved preparation job.');
      const jobDeadline = Math.min(deadline, now() + 5 * 60000);
      let status = 'deferred';
      let next = now() + 5 * 60000;
      let ready: SourceCreatorResult | undefined;
      let retry = 0;
      try {
        // Input snapshots stay identical across all checkpoints in this attempt.
        const params = new URLSearchParams({ id: job.id });
        const [transcript, notes, description] = await Promise.all([
          preparationFetch(
            new URL('/api/transcript?' + params, options.site),
            signal,
            fetcher,
          ),
          preparationFetch(
            new URL('/api/study-notes?' + params, options.site),
            signal,
            fetcher,
          ),
          preparationFetch(
            new URL('https://yutorah.org/api/shiur/details?shiurID=' + job.id),
            signal,
            fetcher,
          )
            .then(async (response) =>
              response.ok
                ? Response.json(
                    sourceDescription(await response.json(), job.id),
                  )
                : response,
            )
            .catch(() => Response.json({}, { status: 503 })),
        ]);
        const request = new Request(
          new URL('/api/source-creator?' + params, options.site),
        );
        for (
          let pass = 0;
          pass < 450 && active() && now() < jobDeadline;
          pass++
        ) {
          const response = await sourceCreatorResponse(request, {
            db,
            features: features!,
            fetcher,
            transcript: async () => transcript.clone(),
            notes: async () => notes.clone(),
            description: async () => description.clone(),
          });
          if (response.status === 200) {
            ready = (await response.json()) as SourceCreatorResult;
            if (ready.status !== 'ready')
              throw new Error('Unexpected detector response.');
            status = 'ready';
            next = now() + (ready.transcriptComplete ? 6 * 3600_000 : 15_000);
            if (
              transcript.status >= 500 ||
              notes.status >= 500 ||
              description.status >= 500
            )
              next = now() + 5 * 60000;
            break;
          }
          if (response.status === 404) {
            status = 'missing';
            next = now() + 86400_000;
            break;
          }
          if (![202, 429, 500, 502, 503, 504].includes(response.status))
            throw new Error('Source checking rejected.');
          const pending = response.status === 202;
          if (!pending && ++retry > 3) break;
          if (pending) retry = 0;
          const data = pending
            ? ((await response.json()) as SourceCreatorResult)
            : null;
          const pause =
            pending && data?.waiting === false
              ? 150
              : sourceRetryDelay(response.headers.get('Retry-After'), retry);
          if (now() + pause >= jobDeadline) break;
          await wait(pause, signal);
        }
      } catch {
        if (signal.aborted) throw signal.reason;
        status = 'deferred';
      }
      await save(
        row.id,
        {
          id: job.id,
          status,
          checkedAt: now(),
          attempts: (job.attempts || 0) + 1,
        },
        next,
      );
      summary.processed++;
      if (status === 'ready') summary.ready++;
      else if (status === 'missing') summary.missing++;
      else summary.deferred++;
      consecutiveFailures = status === 'deferred' ? consecutiveFailures + 1 : 0;
      options.report?.({ id: job.id, status, sources: ready?.sources.length });
      if (consecutiveFailures >= 3) break;
      if (active()) await wait(250, signal);
    }
    if (!active()) summary.outcome = 'budget';
    else if (
      (summary.processed && summary.deferred === summary.processed) ||
      (!summary.processed && summary.discoveryFailed)
    )
      summary.outcome = 'upstream-unavailable';
    return summary;
  } finally {
    await db
      .prepare('UPDATE sources_runs SET lease=0 WHERE id=? AND lease=?')
      .bind(lockKey, lease)
      .run();
  }
}
