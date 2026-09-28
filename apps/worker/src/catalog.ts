import { setTimeout as delay } from 'node:timers/promises';
import { Failure, checkAbort, failure } from '../../../packages/antigravity-acp/src/errors.js';
import {
  TranscriptionStore,
  type Profile,
} from '../../../packages/transcription/src/store.js';
import { catalogPage, homepageRecent, mediaURL } from '../../../packages/yutorah-core/src/media.js';

export type CatalogRecord = {
  id: string;
  title: string;
  teacher: string;
  mediaUrl?: string;
  sourceRevision: string;
  published: number;
};

const scalar = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const plain = (value: unknown) =>
  scalar(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** Reject shape or ordering changes rather than advancing past unseen uploads. */
export function catalogRecords(docs: Record<string, unknown>[]): {
  records: CatalogRecord[];
  oldest: number;
} {
  let previous = Infinity;
  const records: CatalogRecord[] = [];
  for (const raw of docs) {
    const published = Date.parse(scalar(raw.shiurDate ?? raw.shiurdate));
    if (!Number.isFinite(published) || published > previous)
      throw new Failure('download');
    previous = published;
    const format = scalar(raw.shiurMediaType ?? raw.mediatypename)
      .toLowerCase()
      .trim();
    if (!['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav', 'webm', 'audio'].includes(format)) continue;
    const id = scalar(raw.shiurID ?? raw.shiurid);
    if (!/^\d{1,12}$/.test(id)) throw new Failure('download');
    const supplied = raw.downloadURL ?? raw.shiurFileURL ?? raw.shiurdownloadurl;
    const media = typeof supplied === 'string' && supplied.trim()
      ? mediaURL(supplied).href
      : undefined;
    records.push({
      id,
      title: plain(raw.shiurTitle ?? raw.shiurtitle) || `YU Torah shiur ${id}`,
      teacher:
        plain(
          (raw.shiurTeachers as Array<{ teacherName?: string }> | undefined)
            ?.[0]?.teacherName ?? raw.teacherfullname,
        ) || 'YU Torah',
      mediaUrl: media,
      sourceRevision: `published:${scalar(raw.shiurDate ?? raw.shiurdate).slice(0, 10)}`,
      published,
    });
  }
  return { records, oldest: previous };
}

async function enqueuePage(
  store: TranscriptionStore,
  profile: Profile,
  records: CatalogRecord[],
  cutoff: number,
  priority: number,
  signal: AbortSignal,
): Promise<number> {
  let accepted = 0;
  for (const item of records) {
    checkAbort(signal);
    if (item.published < cutoff) continue;
    await store.enqueue(
      {
        id: item.id,
        title: item.title,
        teacher: item.teacher,
        mediaUrl: item.mediaUrl,
        sourceRevision: item.sourceRevision,
      },
      profile,
      priority,
    );
    accepted++;
  }
  return accepted;
}

/** Small, frequent feed for near-real-time discovery; the paged scan closes gaps. */
export async function scanHomepage(
  store: TranscriptionStore,
  profile: Profile,
  signal: AbortSignal,
  fetchRecent = homepageRecent,
): Promise<number> {
  const docs = await fetchRecent(signal);
  return enqueuePage(store, profile, catalogRecords(docs).records, -Infinity, 0, signal);
}

/** Each page is bounded; enqueue is idempotent if interrupted mid-page. */
export async function scanRecent(
  store: TranscriptionStore,
  profile: Profile,
  signal: AbortSignal,
  options: {
    pagesPerPoll?: number;
    lookbackDays?: number;
    fetchPage?: typeof catalogPage;
  } = {},
): Promise<{ pages: number; audio: number }> {
  const pagesPerPoll = options.pagesPerPoll ?? 4;
  const lookbackDays = options.lookbackDays ?? 3;
  if (
    !Number.isInteger(pagesPerPoll) ||
    pagesPerPoll < 2 ||
    pagesPerPoll > 20 ||
    !Number.isInteger(lookbackDays) ||
    lookbackDays < 1 ||
    lookbackDays > 30
  )
    throw new Failure('configuration');
  const fetchPage = options.fetchPage ?? catalogPage;
  // A long VM outage extends the scan back to the last completed pass.
  const cutoff = await store.recentCatalogCutoff(lookbackDays);
  const first = await fetchPage(1, signal);
  const parsed = catalogRecords(first.docs);
  let audio = await enqueuePage(store, profile, parsed.records, cutoff, 0, signal);
  if (first.total <= first.docs.length || parsed.oldest < cutoff) {
    const cursor = await store.catalogCursor('recent');
    await store.advanceCatalogCursor('recent', cursor, 2, true);
    return { pages: 1, audio };
  }
  let cursor = await store.catalogCursor('recent');
  if (cursor < 2) {
    await store.advanceCatalogCursor('recent', cursor, 2);
    cursor = 2;
  }
  let pages = 1;
  while (pages < pagesPerPoll) {
    checkAbort(signal);
    const page = await fetchPage(cursor, signal);
    const row = catalogRecords(page.docs);
    audio += await enqueuePage(store, profile, row.records, cutoff, 0, signal);
    pages++;
    const exhausted = cursor * 30 >= page.total || row.oldest < cutoff || !page.docs.length;
    await store.advanceCatalogCursor('recent', cursor, exhausted ? 2 : cursor + 1, exhausted);
    if (exhausted) break;
    cursor++;
  }
  return { pages, audio };
}

/** Explicit archive backfill progresses in small, restartable batches. */
export async function backfillPages(
  store: TranscriptionStore,
  profile: Profile,
  count: number,
  signal: AbortSignal,
  fetchPage = catalogPage,
): Promise<{ pages: number; audio: number; nextPage: number }> {
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Failure('configuration');
  let cursor = await store.catalogCursor('backfill');
  let pages = 0;
  let audio = 0;
  while (pages < count) {
    checkAbort(signal);
    const page = await fetchPage(cursor, signal);
    const row = catalogRecords(page.docs);
    audio += await enqueuePage(store, profile, row.records, -Infinity, -10, signal);
    pages++;
    const exhausted = cursor * 30 >= page.total || !page.docs.length;
    await store.advanceCatalogCursor('backfill', cursor, exhausted ? 1 : cursor + 1);
    cursor = exhausted ? 1 : cursor + 1;
    if (exhausted) break;
  }
  return { pages, audio, nextPage: cursor };
}

export async function pollCatalog(
  store: TranscriptionStore,
  profile: Profile,
  signal: AbortSignal,
  intervalMs: number,
  onEvent: (value: { event: string; code?: string; pages?: number; audio?: number }) => void,
  deepIntervalMs = 3_600_000,
): Promise<void> {
  let nextDeep = 0;
  while (!signal.aborted) {
    try {
      const audio = await scanHomepage(store, profile, signal);
      onEvent({ event: 'catalog_recent', audio });
    } catch (error) {
      if (signal.aborted) break;
      onEvent({ event: 'catalog_scan_failed', code: failure(error).code });
    }
    if (Date.now() >= nextDeep && !signal.aborted) {
      try {
        const result = await scanRecent(store, profile, signal);
        onEvent({ event: 'catalog_backstop', ...result });
        nextDeep = Date.now() + deepIntervalMs;
      } catch (error) {
        if (signal.aborted) break;
        onEvent({ event: 'catalog_scan_failed', code: failure(error).code });
      }
    }
    try {
      await delay(intervalMs, undefined, { signal });
    } catch {
      break;
    }
  }
}
