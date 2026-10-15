import type { SearchResponse } from './api-types';
import { catalogCollection } from './catalog';
import { notesCredential } from './tidb-notes';
import { TiDBNotesStore, unpackNote } from './tidb-notes-store';
import { normalize, upstream, type Shiur } from './yutorah';

export type NotesBundleKind = 'collection' | 'series';
export type NotesBundleItem = {
  id: number;
  title: string;
  teacher: string;
  date: string;
  markdown: string;
};
export type NotesBundlePage = {
  page: number;
  pages: number;
  /** Shiurim in the whole collection or series, and on this page. */
  total: number;
  scanned: number;
  done: boolean;
  items: NotesBundleItem[];
};

const collectionPageSize = 50;
let oldest: { value: number; until: number } | null = null;

async function oldestNotedShiur(store: TiDBNotesStore) {
  if (oldest && oldest.until > Date.now()) return oldest.value;
  const value = await store.oldestShiurId();
  oldest = { value, until: Date.now() + 10 * 60_000 };
  return value;
}

async function seriesPage(id: number, page: number) {
  const query = new URLSearchParams({
    searchTerm: '',
    getFacets: 'false',
    seriesID: String(id),
    start: String(page),
  });
  const data = await upstream<SearchResponse>('search/get?' + query, 600);
  if (!Array.isArray(data.response?.docs))
    throw new Error('This series could not load from YUTorah.');
  const size = data.response.docs.length || 30;
  return {
    shiurim: data.response.docs.map(normalize),
    pages: Math.max(1, Math.ceil(data.response.numFound / size)),
    total: data.response.numFound,
  };
}

async function collectionPage(id: number, page: number) {
  const collection = await catalogCollection(id);
  const start = (page - 1) * collectionPageSize;
  return {
    shiurim: collection.items.slice(start, start + collectionPageSize),
    pages: Math.max(1, Math.ceil(collection.items.length / collectionPageSize)),
    total: collection.items.length,
  };
}

/**
 * One page of a collection or series, reduced to the shiurim that have hosted
 * notes. Series pages arrive newest first, so scanning stops once a page is
 * older than every note in the store.
 */
export async function notesBundlePage(
  kind: NotesBundleKind,
  id: number,
  page: number,
): Promise<NotesBundlePage | null> {
  const credential = notesCredential();
  if (!credential) return null;
  const store = new TiDBNotesStore(credential);
  const [{ shiurim, pages, total }, floor] = await Promise.all([
    kind === 'series' ? seriesPage(id, page) : collectionPage(id, page),
    oldestNotedShiur(store),
  ]);
  const candidates = shiurim.filter((s: Shiur) => s.id >= floor);
  const notes = await store.getMany(candidates.map((s) => String(s.id)));
  const byId = new Map(notes.map((n) => [Number(n.shiurId), n]));
  const items: NotesBundleItem[] = [];
  for (const s of candidates) {
    const note = byId.get(s.id);
    if (!note) continue;
    items.push({
      id: s.id,
      title: s.title,
      teacher: s.teacher,
      date: s.date,
      markdown: await unpackNote(note),
    });
  }
  const exhausted =
    kind === 'series' &&
    shiurim.length > 0 &&
    Math.min(...shiurim.map((s) => s.id)) < floor;
  return {
    page,
    pages,
    total,
    scanned: shiurim.length,
    done: page >= pages || !shiurim.length || exhausted,
    items,
  };
}
