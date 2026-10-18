import type {
  NotesBundleItem,
  NotesBundleKind,
  NotesBundlePage,
} from './notes-bundle';
import type { NotesBundleDocument } from './notes-pdf';
import { saveDownload } from './save-download';

export const notesBundleLimit = 2000;
const parallelPages = 6;

export type NotesBundleProgress =
  | { phase: 'gathering'; found: number; scanned: number; total: number }
  | { phase: 'building'; found: number };

export class NotesBundleEmpty extends Error {}

async function readPage(
  kind: NotesBundleKind,
  id: number,
  page: number,
  signal: AbortSignal,
  version = '',
): Promise<NotesBundlePage> {
  const query = new URLSearchParams({
    kind,
    id: String(id),
    page: String(page),
    ...(version ? { version } : {}),
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch('/api/notes-bundle?' + query, { signal });
    const data: NotesBundlePage & { error?: string } = await response.json();
    const wait = Number(response.headers.get('Retry-After') || 0) * 1000;
    if (
      response.status === 503 &&
      wait > 0 &&
      wait <= 5000 &&
      Date.now() + wait < deadline
    ) {
      await new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, wait);
        signal.addEventListener('abort', abort, { once: true });
      });
      continue;
    }
    if (!response.ok) throw new Error(data.error || 'Notes could not load.');
    if (data.page !== page || (version && data.version !== version))
      throw new Error('The collection changed. Restart the notes download.');
    return data;
  }
}

export async function gatherNotesBundle(
  kind: NotesBundleKind,
  id: number,
  signal: AbortSignal,
  onProgress: (p: NotesBundleProgress) => void,
) {
  const found = new Map<number, NotesBundleItem>();
  const first = await readPage(kind, id, 1, signal);
  if (kind === 'collection' && !/^[a-f0-9]{64}$/.test(first.version || ''))
    throw new Error('The collection could not be verified. Please retry.');
  const total = first.total;
  let next = 2,
    last = first.done ? 1 : first.pages,
    scanned = 0;
  const take = (result: NotesBundlePage) => {
    if (result.page > last) return;
    for (const item of result.items) found.set(item.id, item);
    scanned += result.scanned;
    if (result.done) last = Math.min(last, result.page);
    if (found.size >= notesBundleLimit) last = 0;
    onProgress({
      phase: 'gathering',
      found: found.size,
      scanned: Math.min(scanned, total),
      total,
    });
  };
  take(first);
  const runner = async () => {
    try {
      while (next <= last)
        take(await readPage(kind, id, next++, signal, first.version));
    } catch (error) {
      last = 0;
      throw error;
    }
  };
  await Promise.all(Array.from({ length: parallelPages }, runner));
  return [...found.values()]
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id - b.id)
    .slice(-notesBundleLimit);
}

function build(document: NotesBundleDocument, signal: AbortSignal) {
  return new Promise<Blob>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL('./notes-bundle.worker.ts', import.meta.url),
        {
          type: 'module',
        },
      );
    } catch {
      void import('./notes-pdf')
        .then((m) => m.createNotesBundlePdf(document))
        .then(resolve, reject);
      return;
    }
    const stop = () => {
      worker.terminate();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', stop, { once: true });
    worker.onmessage = (event: MessageEvent<{ blob?: Blob }>) => {
      signal.removeEventListener('abort', stop);
      worker.terminate();
      if (event.data.blob) resolve(event.data.blob);
      else reject(new Error('The PDF could not be created.'));
    };
    worker.onerror = () => {
      signal.removeEventListener('abort', stop);
      worker.terminate();
      reject(new Error('The PDF could not be created.'));
    };
    worker.postMessage(document);
  });
}

/** Gathers every shiur with notes in a collection or series into one PDF. */
export async function downloadNotesBundle({
  kind,
  id,
  name,
  signal,
  onProgress,
}: {
  kind: NotesBundleKind;
  id: number;
  name: string;
  signal: AbortSignal;
  onProgress: (p: NotesBundleProgress) => void;
}) {
  const items = await gatherNotesBundle(kind, id, signal, onProgress);
  if (!items.length) throw new NotesBundleEmpty();
  onProgress({ phase: 'building', found: items.length });
  const teachers = [...new Set(items.map((i) => i.teacher).filter(Boolean))];
  const blob = await build(
    {
      title: name,
      subtitle: [
        teachers.length === 1 ? teachers[0] : '',
        `${items.length.toLocaleString()} ${items.length === 1 ? 'shiur' : 'shiurim'} with notes`,
      ]
        .filter(Boolean)
        .join(' · '),
      items,
    },
    signal,
  );
  const slug =
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || kind + '-' + id;
  saveDownload(blob, `${slug}-notes.pdf`);
  return items.length;
}
