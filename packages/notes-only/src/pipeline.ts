import { mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
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
import {
  NOTES_NORMALIZER,
  notesViolations,
  normalizeNotes,
  violationCode,
} from './notes.js';
import {
  assessNotesLanguage,
  hebrewNotesBody,
  transcriptText,
} from './language.js';
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
          !job.redo_reason &&
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
      redo_reason: null,
    });
  }
  async generating(job: NoteJob, signal: AbortSignal) {
    const { root, queue, identity, store } = this.config;
    await this.config.reconcileRuntime(job);
    signal.throwIfAborted();
    if (!queue.owns(job)) throw new PipelineFailure('lease_lost');
    if (!job.source_path || !job.source_hash)
      throw new PipelineFailure('invalid_transcript', 'yutorah');
    // Ready sources can outlive another writer's publication, particularly after
    // a timeout. Recheck before spending inference on a regeneration/repair retry.
    if (
      job.generation_attempts > 1 &&
      (job.redo_reason || this.config.regenerationStartedAt)
    ) {
      if (!queue.available('tidb'))
        throw new PipelineFailure('publication_unknown', 'tidb', 30_000);
      let published: SavedNote | null;
      try {
        published = await store.get(job.id);
      } catch (error) {
        const e = classify(error, 'tidb');
        throw new PipelineFailure(
          e.code,
          'tidb',
          e.retryAfterMs || 30_000,
          e.pause,
        );
      }
      if (
        published &&
        (await this.canAdoptConcurrentPublication(job, published))
      ) {
        signal.throwIfAborted();
        await this.completeExisting(job, published);
        queue.event('publication', 'retry_publication_adopted', job.id);
        return 'completed';
      }
    }
    const bytes = await readFile(statePath(root, job.source_path));
    if (digest(bytes) !== job.source_hash)
      throw new PipelineFailure('source_changed', 'yutorah');
    const vtt = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const cues = parseVtt(vtt);
    const source = cues
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
    queue.db
      .prepare(
        'INSERT OR IGNORE INTO generation_attempts(token,job_id,started_at,source_chars,source_seconds,normalizer) VALUES(?,?,?,?,?,?)',
      )
      .run(
        job.lease_token,
        job.id,
        Date.now(),
        source.length,
        cues.reduce((end, c) => Math.max(end, c.endMs), 0) / 1000,
        NOTES_NORMALIZER,
      );
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
    let markdown: string;
    try {
      markdown = await this.config.generate(source, job, signal, evidenceDir);
    } finally {
      queue.db
        .prepare(
          'UPDATE generation_attempts SET evidence_bytes=? WHERE token=?',
        )
        .run(await directoryBytes(evidenceDir), job.lease_token);
    }
    signal.throwIfAborted();
    const commitAt = Date.now();
    if (assessNotesLanguage(markdown, source).unexpectedHebrew)
      throw new PipelineFailure('unexpected_hebrew');
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
    queue.event('artifact_commit', 'accepted', job.id, Date.now() - commitAt);
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
    await this.validateArtifactLanguage(
      job,
      await unpackNote(note),
      note.sourceHash,
    );
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
      if (await this.canAdoptConcurrentPublication(job, published)) {
        await this.completeExisting(job, published);
        queue.event('publication', 'validated_replacement_adopted', job.id);
        return 'completed';
      }
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
    queue.finish(job, { status: 'completed', error: null, redo_reason: null });
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
        try {
          await this.validateArtifactLanguage(
            owned,
            await unpackNote(note),
            note.sourceHash,
          );
        } catch (error) {
          if (
            ['unexpected_hebrew', 'language_source_unavailable'].includes(
              (error as PipelineFailure).code,
            )
          ) {
            queue.finish(owned, {
              status: 'needs_review',
              review: 'rejected',
              error: (error as PipelineFailure).code,
            });
            continue;
          }
          throw error;
        }
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
        try {
          await this.validateArtifactLanguage(
            owned,
            await unpackNote(note),
            note.sourceHash,
          );
        } catch (error) {
          if (
            ['unexpected_hebrew', 'language_source_unavailable'].includes(
              (error as PipelineFailure).code,
            )
          ) {
            queue.event(
              'validation',
              (error as PipelineFailure).code,
              owned.id,
            );
            continue;
          }
          throw error;
        }
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
  /** A concurrent publication may win; require exact source/profile, freshness and all contract checks. */
  private async canAdoptConcurrentPublication(job: NoteJob, note: SavedNote) {
    if (
      !this.config.identity.approved ||
      note.shiurId !== job.id ||
      note.sourceHash !== job.source_hash ||
      note.generatorVersion !== this.config.identity.profile
    )
      return false;
    const finding = job.redo_reason
      ? this.config.queue.db
          .prepare(
            'SELECT MAX(queued_at) AS at FROM language_findings WHERE job_id=? AND queued_at IS NOT NULL AND replaced_at IS NULL',
          )
          .get(job.id)
      : null;
    const boundary = job.redo_reason
      ? Number(finding?.at ?? 0)
      : (this.config.regenerationStartedAt ?? 0);
    if (
      !boundary ||
      !Number.isSafeInteger(note.createdAtMs) ||
      note.createdAtMs < boundary ||
      note.createdAtMs < (this.config.regenerationStartedAt ?? 0)
    )
      return false;
    try {
      const source = await this.validatedSource(job, note.sourceHash);
      return notesViolations(await unpackNote(note), source).length === 0;
    } catch (error) {
      if ((error as PipelineFailure).code === 'language_source_unavailable')
        return false;
      throw error;
    }
  }
  /** Recheck saved evidence under an exclusive paused runner; no model request or public write occurs here. */
  async recheckSaved(job: NoteJob, signal: AbortSignal) {
    const { queue, root, identity } = this.config;
    signal.throwIfAborted();
    if (!queue.owns(job)) throw new PipelineFailure('lease_lost');
    if (job.error === 'published_hash_conflict') {
      const published = await this.config.store.get(job.id);
      if (
        !published ||
        !(await this.canAdoptConcurrentPublication(job, published))
      )
        return 'requires_review';
      await this.completeExisting(job, published);
      queue.event('revalidation', 'published_replacement_adopted', job.id);
      return 'completed';
    }
    if (
      job.error !== 'incomplete_output' ||
      job.artifact_path ||
      !identity.approved
    )
      return 'requires_review';
    const attempt = queue.db
      .prepare(
        'SELECT token FROM generation_attempts WHERE job_id=? ORDER BY started_at DESC LIMIT 1',
      )
      .get(job.id);
    if (!attempt || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(attempt.token)))
      return 'missing_evidence';
    const token = String(attempt.token),
      folder = join(root, 'attempts', job.id, token);
    const recorded = JSON.parse(
      await readFile(join(folder, 'identity.json'), 'utf8'),
    );
    if (
      recorded.job !== job.id ||
      recorded.token !== token ||
      recorded.profile !== identity.profile ||
      recorded.sourceHash !== job.source_hash ||
      recorded.route !== identity.route
    )
      return 'identity_mismatch';
    const request = queue.db
      .prepare(
        "SELECT id,kind,status,cost,evidence FROM requests WHERE job_id=? AND token=? AND kind IN ('generation','repair') ORDER BY started_at DESC,rowid DESC LIMIT 1",
      )
      .get(job.id, token);
    if (
      !request ||
      request.status !== 'completed' ||
      request.cost !== 0 ||
      !request.evidence
    )
      return 'unverified_request';
    const raw = await readFile(
      join(folder, String(request.id) + '.raw.txt'),
      'utf8',
    );
    const previous = await readFile(
      join(folder, String(request.kind) + '.normalized.md'),
      'utf8',
    );
    if (normalizeNotes(raw) !== previous) return 'evidence_mismatch';
    const source = await this.validatedSource(job, job.source_hash!);
    const failures = notesViolations(previous, source).map(violationCode);
    if (
      !failures.length ||
      failures.some((code) => code !== 'hebrew_vocalization')
    )
      return 'requires_review';
    const markdown = normalizeNotes(raw, source);
    if (notesViolations(markdown, source).length) return 'requires_review';
    signal.throwIfAborted();
    if (!queue.owns(job)) throw new PipelineFailure('lease_lost');
    const provenance = {
      normalizer: NOTES_NORMALIZER,
      attempt: token,
      request: String(request.id),
      beforeHash: digest(previous),
      afterHash: digest(markdown),
    };
    const path = join(
      'artifacts',
      job.id,
      job.source_hash!,
      identity.profile,
      'revalidated-' + job.lease_token,
    );
    const evidence = join(root, 'attempts', job.id, job.lease_token);
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    await durableWrite(
      join(evidence, 'revalidation.json'),
      JSON.stringify({
        ...provenance,
        sourceHash: job.source_hash,
        profile: identity.profile,
      }),
    );
    const generator = JSON.stringify({
      configuration: identity.generator,
      revalidatedFrom: provenance,
    });
    const note = await packNote({
      shiurId: job.id,
      sourceHash: job.source_hash!,
      generatorVersion: identity.profile,
      language: 'hebrewEnglish',
      markdown,
    });
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
    const manifest = await saveArtifact(root, path, note, {
      profile: identity.profile,
      generator,
      route: identity.route,
      review: 'approved_route',
      attempt: job.lease_token,
    });
    queue.accept(job, {
      status: 'generated',
      artifact_path: path,
      artifact_bytes:
        manifest.gzipBytes + Buffer.byteLength(JSON.stringify(manifest)),
      notes_hash: note.notesHash,
      profile: identity.profile,
      generator,
      route: identity.route,
      review: 'approved_route',
      eligibility: 'eligible',
      error: null,
      next_at: 0,
    });
    queue.event('revalidation', 'formatting_recovered', job.id);
    return 'generated';
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
  async auditQuarantine() {
    const { queue, root } = this.config;
    const rows = queue.db
      .prepare(`SELECT j.id FROM jobs j LEFT JOIN quarantine_evidence q ON q.job_id=j.id
      WHERE (j.status IN ('needs_review','conflict') OR (j.status='generated' AND j.review NOT IN ('approved_route','accepted')))
        AND (q.checked_at IS NULL OR q.checked_at<j.updated_at) LIMIT 100`)
      .all();
    for (const row of rows) {
      const bytes = await directoryBytes(
        join(root, 'attempts', String(row.id)),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      queue.db
        .prepare(
          'INSERT INTO quarantine_evidence VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET bytes=excluded.bytes,checked_at=excluded.checked_at',
        )
        .run(row.id!, bytes, Date.now());
    }
    return rows.length;
  }
  private async validateArtifactLanguage(
    job: NoteJob,
    markdown: string,
    sourceHash: string,
  ) {
    if (!hebrewNotesBody(markdown)) return;
    if (
      assessNotesLanguage(markdown, await this.validatedSource(job, sourceHash))
        .unexpectedHebrew
    )
      throw new PipelineFailure('unexpected_hebrew');
  }
  private async validatedSource(job: NoteJob, sourceHash: string) {
    if (!job.source_path || job.source_hash !== sourceHash)
      throw new PipelineFailure('language_source_unavailable');
    const bytes = await readFile(
      statePath(this.config.root, job.source_path),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        throw new PipelineFailure('language_source_unavailable');
      throw error;
    });
    if (digest(bytes) !== sourceHash)
      throw new PipelineFailure('source_changed', 'yutorah');
    return transcriptText(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  }
}

/** Private attempt evidence is retained even for a rejected draft. Never follows symlinks. */
async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}
