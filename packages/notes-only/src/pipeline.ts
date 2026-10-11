import { mkdir, readFile, rename, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TiDBNotesStore,
  packNote,
  unpackNote,
  notesHash,
  type SavedNote,
} from '../../../lib/tidb-notes-store.js';
import { parseVtt } from '../../../lib/webvtt.mjs';
import { fetchOfficialVtt } from '../../../lib/official-transcript.mjs';
export { fetchOfficialVtt } from '../../../lib/official-transcript.mjs';
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
export type NotesPublisher = Pick<TiDBNotesStore, 'get'> & {
  publish: (note: SavedNote) => Promise<SavedNote | void>;
};
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
      if (published.shiurId !== job.id)
        throw new Error('Notes publication was not confirmed.');
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
    const canonical = await store.publish(note);
    if (canonical) {
      if (canonical.shiurId !== job.id)
        throw new Error('Notes publication was not confirmed.');
      await unpackNote(canonical);
      if (
        canonical.notesHash !== note.notesHash ||
        canonical.sourceHash !== note.sourceHash ||
        canonical.generatorVersion !== note.generatorVersion ||
        canonical.createdAtMs !== note.createdAtMs ||
        canonical.language !== note.language
      )
        await this.saveBackup(backup, canonical);
    }
    // A durable completion checkpoint precedes source deletion. publish verifies hashes.
    queue.completed(job.id, canonical?.notesHash ?? note.notesHash);
    await rm(temporary, { recursive: true, force: true });
    return canonical && canonical.notesHash !== note.notesHash
      ? 'already_published'
      : 'completed';
  }
  private async saveBackup(path: string, note: SavedNote) {
    // Keep a generated alternative before adopting a different published note.
    const previous = await readFile(join(path, 'metadata.json'), 'utf8')
      .then(JSON.parse)
      .catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
    if (previous && previous.notesHash !== note.notesHash) {
      const alternative: SavedNote = {
        ...previous,
        gzip: new Uint8Array(await readFile(join(path, 'notes.md.gz'))),
      };
      if (alternative.shiurId !== note.shiurId)
        throw new Error('Backup shiur conflict.');
      await unpackNote(alternative);
      const archive = join(path, 'unpublished', alternative.notesHash);
      await mkdir(archive, { recursive: true, mode: 0o700 });
      const { gzip, ...metadata } = alternative;
      await durableWrite(join(archive, 'notes.md.gz'), gzip);
      await durableWrite(
        join(archive, 'metadata.json'),
        JSON.stringify(metadata),
      );
      const directory = await open(join(path, 'unpublished'), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const { gzip, ...metadata } = note;
    await durableWrite(join(path, 'notes.md.gz'), gzip);
    await durableWrite(join(path, 'metadata.json'), JSON.stringify(metadata));
  }
}
