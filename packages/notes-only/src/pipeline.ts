import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  packNote,
  unpackNote,
  type SavedNote,
  type TiDBNotesStore,
} from '../../../lib/tidb-notes-store.js';
import { parseVtt } from '../../../lib/webvtt.mjs';
import { fetchOfficialVtt } from '../../../lib/official-transcript.mjs';
import { NotesQueue, type NoteJob } from './queue.js';
import {
  durableWrite,
  digest,
  loadArtifact,
  saveArtifact,
  pinSource,
  statePath,
} from './artifacts.js';
import { PipelineFailure, classify } from './control.js';
export { durableWrite } from './artifacts.js';
export type NotesPublisher = Pick<TiDBNotesStore, 'get' | 'publish'>;
export type GeneratorIdentity = {
  profile: string;
  generator: string;
  route: 'acp-high' | 'server-high';
  approved: boolean;
};
export class NotesPipeline {
  constructor(
    readonly config: {
      root: string;
      queue: NotesQueue;
      store: NotesPublisher;
      identity: GeneratorIdentity;
      generate: (
        source: string,
        job: NoteJob,
        signal: AbortSignal,
        evidenceDir: string,
      ) => Promise<string>;
      fetchTranscript?: (
        id: string,
        signal: AbortSignal,
      ) => Promise<string | null>;
      reconcileRuntime: (job: NoteJob) => Promise<void>;
      sourceRetentionMs?: number;
      regenerationStartedAt?: number;
    },
  ) {}
  async fetching(job: NoteJob, signal: AbortSignal) {
    const { root, queue, store } = this.config;
    signal.throwIfAborted();
    let source = job.source_path
      ? {
          path: job.source_path,
          hash: job.source_hash!,
          bytes: job.source_bytes,
        }
      : null;
    // A failed eligibility lookup never becomes evidence of an absent published note.
    let eligibility = 'unknown';
    let replaceHash: string | null = job.replace_hash;
    if (queue.available('tidb')) {
      try {
        const published = await store.get(job.id);
        if (
          published &&
          !(
            this.config.regenerationStartedAt &&
            (published.generatorVersion !== this.config.identity.profile ||
              published.createdAtMs < this.config.regenerationStartedAt)
          )
        ) {
          await this.completeExisting(job, published);
          return 'already_published';
        }
        if (published) {
          await unpackNote(published);
          const path = join(
            'artifacts',
            job.id,
            published.sourceHash,
            published.generatorVersion,
            'before-replacement-' + job.lease_token,
          );
          await saveArtifact(root, path, published, {
            profile: published.generatorVersion,
            generator: JSON.stringify({
              provenance: 'published_before_replacement',
            }),
            route: 'existing',
            review: 'published',
            attempt: job.lease_token,
          });
          queue.journal(job.id, path, published.notesHash);
          replaceHash = published.notesHash;
        }
        eligibility = 'eligible';
      } catch (error) {
        const e = classify(error, 'tidb');
        queue.cooldown('tidb', e.retryAfterMs || 30_000, e.code, e.pause);
      }
    }
    if (!source) {
      const vtt = await (this.config.fetchTranscript ?? fetchOfficialVtt)(
        job.id,
        signal,
      );
      if (vtt === null) {
        queue.finish(job, {
          status: 'missing',
          next_at: Date.now() + 7 * 86400_000,
          error: null,
        });
        return 'missing';
      }
      const cues = parseVtt(vtt);
      if (!cues.length) {
        queue.finish(job, {
          status: 'missing',
          next_at: Date.now() + 7 * 86400_000,
        });
        return 'missing';
      }
      source = await pinSource(root, job.id, vtt);
    }
    signal.throwIfAborted();
    queue.finish(job, {
      status: 'ready',
      source_path: source.path,
      source_hash: source.hash,
      source_bytes: source.bytes,
      eligibility,
      replace_hash: replaceHash,
      error: eligibility === 'unknown' ? 'eligibility_unknown' : null,
      next_at: eligibility === 'unknown' ? Date.now() + 30_000 : 0,
    });
    return 'ready';
  }
  private async completeExisting(job: NoteJob, note: SavedNote) {
    if (note.shiurId !== job.id)
      throw new PipelineFailure('publication_invalid', 'tidb', 0, true);
    await unpackNote(note);
    const path = join(
      'artifacts',
      job.id,
      note.sourceHash,
      note.generatorVersion,
      'published-' + job.lease_token,
    );
    const manifest = await saveArtifact(this.config.root, path, note, {
      profile: note.generatorVersion,
      generator: JSON.stringify({
        provenance: 'published',
        profile: note.generatorVersion,
      }),
      route: 'existing',
      review: 'published',
      attempt: job.lease_token,
    });
    this.config.queue.accept(job, {
      status: 'completed',
      artifact_path: path,
      artifact_bytes:
        manifest.gzipBytes + Buffer.byteLength(JSON.stringify(manifest)),
      source_hash: note.sourceHash,
      notes_hash: note.notesHash,
      profile: manifest.profile,
      generator: manifest.generator,
      review: 'published',
      eligibility: 'published',
      error: null,
    });
  }
  async generating(job: NoteJob, signal: AbortSignal) {
    const { root, queue, identity } = this.config;
    await this.config.reconcileRuntime(job);
    signal.throwIfAborted();
    if (!queue.owns(job)) throw new PipelineFailure('lease_lost');
    if (!job.source_path || !job.source_hash)
      throw new PipelineFailure('invalid_transcript', 'yutorah');
    const bytes = await readFile(statePath(root, job.source_path));
    if (digest(bytes) !== job.source_hash)
      throw new PipelineFailure('source_changed', 'yutorah');
    const vtt = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const source = parseVtt(vtt)
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
    if (!source.trim())
      throw new PipelineFailure('invalid_transcript', 'yutorah');
    const path = join(
      'artifacts',
      job.id,
      job.source_hash,
      identity.profile,
      job.lease_token,
    );
    queue.db
      .prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)')
      .run(
        job.lease_token,
        job.id,
        job.source_hash,
        identity.profile,
        path,
        Date.now(),
      );
    const evidenceDir = join(root, 'attempts', job.id, job.lease_token);
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await durableWrite(
      join(evidenceDir, 'identity.json'),
      JSON.stringify({
        ...identity,
        sourceHash: job.source_hash,
        sourcePath: job.source_path,
        job: job.id,
        token: job.lease_token,
      }),
    );
    const markdown = await this.config.generate(
      source,
      job,
      signal,
      evidenceDir,
    );
    signal.throwIfAborted();
    const note = await packNote({
      shiurId: job.id,
      sourceHash: job.source_hash,
      generatorVersion: identity.profile,
      language: 'hebrewEnglish',
      markdown,
    });
    const review = identity.approved ? 'approved_route' : 'pending';
    const manifest = await saveArtifact(root, path, note, {
      ...identity,
      review,
      attempt: job.lease_token,
    });
    // A stale worker may leave an immutable orphan, but cannot accept or publish it.
    queue.accept(job, {
      status: identity.approved ? 'generated' : 'needs_review',
      artifact_path: path,
      artifact_bytes:
        manifest.gzipBytes + Buffer.byteLength(JSON.stringify(manifest)),
      notes_hash: note.notesHash,
      profile: identity.profile,
      generator: identity.generator,
      route: identity.route,
      review,
      error: null,
      next_at: 0,
    });
    return identity.approved ? 'generated' : 'needs_review';
  }
  async publishing(job: NoteJob, signal: AbortSignal) {
    const { root, queue, store } = this.config;
    if (!job.artifact_path)
      throw new PipelineFailure('publication_invalid', 'tidb');
    const { note } = await loadArtifact(root, job.artifact_path);
    if (
      note.shiurId !== job.id ||
      note.notesHash !== job.notes_hash ||
      note.generatorVersion !== job.profile
    )
      throw new PipelineFailure('publication_invalid', 'tidb');
    // Freeze identity before the irreversible insert. Completion still requires the current lease.
    signal.throwIfAborted();
    if (!queue.owns(job)) throw new PipelineFailure('lease_lost');
    const published = await store.publish(note, job.replace_hash);
    if (!published || published.shiurId !== job.id)
      throw new PipelineFailure('publication_invalid', 'tidb');
    await unpackNote(published);
    if (
      published.notesHash !== note.notesHash ||
      published.sourceHash !== note.sourceHash ||
      published.generatorVersion !== note.generatorVersion
    ) {
      const path = join(
        'artifacts',
        job.id,
        published.sourceHash,
        published.generatorVersion,
        'conflicting-published-' + job.lease_token,
      );
      await saveArtifact(root, path, published, {
        profile: published.generatorVersion,
        generator: JSON.stringify({ provenance: 'conflicting_published' }),
        route: 'existing',
        review: 'published',
        attempt: job.lease_token,
      });
      queue.journal(job.id, path, published.notesHash);
      queue.finish(job, {
        status: 'conflict',
        error: 'published_hash_conflict',
      });
      return 'conflict';
    }
    queue.finish(job, { status: 'completed', error: null });
    return 'completed';
  }
  async recoverExpired() {
    const { queue, root } = this.config;
    for (const expired of queue.expired()) {
      const owned = queue.fence(expired);
      if (!owned) continue;
      await this.config.reconcileRuntime(expired);
      if (owned.artifact_path) {
        const { note } = await loadArtifact(root, owned.artifact_path);
        if (note.notesHash !== owned.notes_hash)
          throw new PipelineFailure('publication_invalid', 'tidb', 0, true);
        queue.finish(owned, {
          status: owned.review === 'pending' ? 'needs_review' : 'generated',
          error: 'recovered_artifact',
          next_at: 0,
        });
        continue;
      }
      const candidates = queue.db
        .prepare(
          'SELECT * FROM generation_artifacts WHERE job_id=? ORDER BY created_at DESC',
        )
        .all(owned.id);
      let adopted = false;
      for (const candidate of candidates) {
        if (
          candidate.source_hash !== owned.source_hash ||
          candidate.profile !== this.config.identity.profile
        )
          continue;
        const artifact = await loadArtifact(root, String(candidate.path)).catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          },
        );
        if (!artifact) continue;
        const { note, manifest } = artifact;
        if (
          note.shiurId !== owned.id ||
          note.sourceHash !== candidate.source_hash ||
          manifest.attempt !== candidate.token ||
          manifest.profile !== candidate.profile
        )
          throw new PipelineFailure('publication_invalid', 'tidb', 0, true);
        queue.accept(owned, {
          status: manifest.review === 'pending' ? 'needs_review' : 'generated',
          artifact_path: String(candidate.path),
          artifact_bytes:
            manifest.gzipBytes + Buffer.byteLength(JSON.stringify(manifest)),
          notes_hash: note.notesHash,
          profile: manifest.profile,
          generator: manifest.generator,
          route: manifest.route,
          review: manifest.review,
          error: 'adopted_crash_artifact',
          next_at: 0,
        });
        adopted = true;
        break;
      }
      if (!adopted)
        queue.finish(owned, {
          status: owned.source_path ? 'ready' : 'discovered',
          error: 'recovered_expired_lease',
          next_at: 0,
        });
    }
  }
  async reclaim(now = Date.now()) {
    // Accepted notes are retained. Sources are reclaimable only after completion and the backup checkpoint.
    const rows = this.config.queue.db
      .prepare(`SELECT j.id,j.source_path FROM jobs j JOIN backup_journal b ON b.path=j.artifact_path
      WHERE j.status='completed' AND j.source_path IS NOT NULL AND b.backed_up_at IS NOT NULL AND j.completed_at<?`)
      .all(now - (this.config.sourceRetentionMs ?? 86400_000));
    for (const row of rows) {
      await rm(statePath(this.config.root, String(row.source_path)), {
        force: true,
      });
      this.config.queue.db
        .prepare(
          "UPDATE jobs SET source_path=NULL,source_bytes=0 WHERE id=? AND status='completed'",
        )
        .run(row.id!);
    }
    return rows.length;
  }
}
