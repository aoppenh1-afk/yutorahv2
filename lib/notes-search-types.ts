import type { Shiur } from './yutorah';

export type NotesSearchHit = {
  shiur: Shiur;
  excerpt: string;
  notesHash: string;
  href: string;
};
export type NotesSearchResult = {
  items: NotesSearchHit[];
  total: number;
  nextPage: number | null;
  snapshot: string;
  updatedAt: number;
};
