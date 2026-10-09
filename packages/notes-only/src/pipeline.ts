import { mkdir, readFile, rename, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TiDBNotesStore,
  packNote,
  unpackNote,
  notesHash,
  streamBytes,
  type SavedNote,
} from '../../../lib/tidb-notes-store.js';
import { parseVtt } from '../../../lib/webvtt.mjs';
import { NotesQueue, type NoteJob } from './queue.js';

export async function durableWrite(path: string, data: string | Uint8Array) {
  const temporary = path + '.next';
  const file = await open(temporary, 'w', 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(join(path, '..'), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export type NotesPublisher = Pick<TiDBNotesStore, 'get' | 'publish'>;
export class NotesPipeline {
  constructor(
    readonly config: {
      root: string;
      queue: NotesQueue;
      store: NotesPublisher;
      generatorVersion: string;
      language: string;
      generate: (source: string, job: NoteJob) => Promise<string>;
      signal: AbortSignal;
      fetchTranscript?: (
        id: string,
        signal: AbortSignal,
      ) => Promise<string | null>;
      cleanupRuntime?: (scratch: string) => Promise<void>;
    },
  ) {}
  async process(job: NoteJob) {
    const { root, queue, store, signal } = this.config;
    signal.throwIfAborted();
    const temporary = join(root, 'jobs', job.id);
    const backup = join(root, 'notes', job.id);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await this.config.cleanupRuntime?.(join(temporary, 'acp'));
    const published = await store.get(job.id);
    if (published) {
      await unpackNote(published);
      await this.saveBackup(backup, published);
      queue.completed(job.id, published.notesHash);
      await rm(temporary, { recursive: true, force: true });
      return 'already_published';
    }
    const metadata = await readFile(join(backup, 'metadata.json'), 'utf8')
      .then(JSON.parse)
      .catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
    let note: SavedNote;
    if (metadata) {
      note = {
        ...metadata,
        gzip: new Uint8Array(await readFile(join(backup, 'notes.md.gz'))),
      };
      if (
        note.shiurId !== job.id ||
        note.generatorVersion !== this.config.generatorVersion
      )
        throw new Error('Backup version conflict.');
      await unpackNote(note);
    } else {
      let vtt = await readFile(join(temporary, 'source.vtt'), 'utf8').catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        },
      );
      if (vtt === null) {
        vtt = await (this.config.fetchTranscript ?? fetchOfficialVtt)(
          job.id,
          signal,
        );
        if (vtt === null) {
          queue.missing(job.id);
          await rm(temporary, { recursive: true, force: true });
          return 'missing';
        }
        await durableWrite(join(temporary, 'source.vtt'), vtt);
      }
      const cues = parseVtt(vtt);
      if (!cues.length) {
        queue.missing(job.id);
        await rm(temporary, { recursive: true, force: true });
        return 'missing';
      }
      // Every cue is included; never sample or truncate a lecture to fit a model.
      const text = cues
        .map((c) =>
          c.text
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ')
            .replace(/&quot;/g, '"'),
        )
        .join('\n\n');
      const sourceHash = await notesHash(new TextEncoder().encode(vtt));
      const markdown = await this.config.generate(text, job);
      note = await packNote({
        shiurId: job.id,
        sourceHash,
        generatorVersion: this.config.generatorVersion,
        language: this.config.language,
        markdown,
      });
      await this.saveBackup(backup, note);
      await this.config.cleanupRuntime?.(join(temporary, 'acp'));
    }
    signal.throwIfAborted();
    await store.publish(note);
    // A durable completion checkpoint precedes source deletion. publish verifies hashes.
    queue.completed(job.id, note.notesHash);
    await rm(temporary, { recursive: true, force: true });
    return 'completed';
  }
  private async saveBackup(path: string, note: SavedNote) {
    const { gzip, ...metadata } = note;
    await durableWrite(join(path, 'notes.md.gz'), gzip);
    await durableWrite(join(path, 'metadata.json'), JSON.stringify(metadata));
  }
}
export async function fetchOfficialVtt(
  id: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(
    `https://api.yutorah.org/transcriptions/shiur/${id}/vtt`,
    {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    },
  );
  if (response.status === 404 || response.status === 204) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`Upstream HTTP ${response.status}`) as Error & {
      retryAfterMs?: number;
    };
    const value = response.headers.get('Retry-After');
    const seconds = Number(value);
    if (value)
      error.retryAfterMs = Number.isFinite(seconds)
        ? seconds * 1000
        : Math.max(0, Date.parse(value) - Date.now());
    throw error;
  }
  if (!response.body) throw new Error('Empty transcript response.');
  const bytes = await streamBytes(response.body, 8 * 1024 * 1024);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.trim()) return null;
  const cues = parseVtt(text);
  if (cues.length > 5000) throw new Error('Too many transcript cues.');
  return cues.length ? text : null;
}
