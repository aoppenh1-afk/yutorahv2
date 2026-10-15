import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type NoteMetadata,
  type SavedNote,
  unpackNote,
} from '../../../lib/tidb-notes-store.js';
import { fetchOfficialVtt } from '../../../lib/official-transcript.mjs';
import {
  digest,
  durableWrite,
  loadArtifact,
  pinSource,
  saveArtifact,
  statePath,
} from './artifacts.js';
import {
  assessNotesLanguage,
  hebrewNotesBody,
  NOTES_LANGUAGE_POLICY,
  transcriptText,
} from './language.js';
import { type NoteJob, NotesQueue } from './queue.js';

type Source = { path: string; hash: string; bytes: number };
const matchesMetadata = (note: NoteMetadata, expected: NoteMetadata) =>
  note.shiurId === expected.shiurId &&
  note.notesHash === expected.notesHash &&
  note.sourceHash === expected.sourceHash &&
  note.generatorVersion === expected.generatorVersion &&
  note.rawBytes === expected.rawBytes;
export type LanguageFinding = {
  id: string;
  notesHash: string;
  sourceHash: string;
  scope: 'published' | 'draft';
  verdict:
    | 'unexpected_hebrew'
    | 'hebrew_source'
    | 'language_source_unavailable';
  artifactPath: string;
  source: Source | null;
  originalSource: boolean;
  assessment: ReturnType<typeof assessNotesLanguage>;
  sourceError?: string;
};

/** Caller holds the process lock and has stopped inference. Public bytes stay until a valid CAS replacement. */
export function queueLanguageRedo(
  queue: NotesQueue,
  finding: LanguageFinding,
  now = Date.now(),
) {
  queue.enqueue([{ id: finding.id }]);
  return queue.transaction(() => {
    const prior = queue.db
      .prepare(
        'SELECT queued_at FROM language_findings WHERE job_id=? AND notes_hash=? AND scope=?',
      )
      .get(finding.id, finding.notesHash, finding.scope);
    if (prior?.queued_at) return false;
    const job = queue.db
      .prepare('SELECT * FROM jobs WHERE id=?')
      .get(finding.id) as NoteJob;
    if (job.lease_token)
      throw new Error('Cannot requeue a leased language finding.');
    queue.db
      .prepare(`INSERT INTO language_findings(job_id,notes_hash,source_hash,policy,scope,verdict,assessment,artifact_path,detected_at,queued_at,previous_job)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,notes_hash,scope) DO UPDATE SET
      verdict=excluded.verdict,assessment=excluded.assessment,queued_at=excluded.queued_at,previous_job=excluded.previous_job`)
      .run(
        finding.id,
        finding.notesHash,
        finding.sourceHash,
        NOTES_LANGUAGE_POLICY,
        finding.scope,
        finding.verdict,
        JSON.stringify(finding),
        finding.artifactPath,
        now,
        now,
        JSON.stringify(job),
      );
    queue.journal(finding.id, finding.artifactPath, finding.notesHash);
    queue.db
      .prepare(`UPDATE jobs SET status='discovered',priority=3,redo_reason=?,error=?,next_at=0,
      source_path=?,source_hash=?,source_bytes=?,eligibility='unknown',
      replace_hash=?,artifact_path=NULL,notes_hash=NULL,artifact_bytes=0,profile=NULL,generator=NULL,
      review='pending',completed_at=NULL,ready_at=NULL,reserved_source=0,reserved_outbox=0,updated_at=? WHERE id=?`)
      .run(
        finding.verdict,
        finding.verdict,
        finding.source?.path ?? null,
        finding.source?.hash ?? null,
        finding.source?.bytes ?? 0,
        finding.scope === 'published' ? finding.notesHash : job.replace_hash,
        now,
        finding.id,
      );
    queue.event('language_audit', 'redo_queued', finding.id);
    return true;
  });
}

export async function auditNotesLanguage(input: {
  root: string;
  queue: NotesQueue;
  store: {
    get(id: string): Promise<SavedNote | null>;
    listMetadata(after?: string, limit?: number): Promise<NoteMetadata[]>;
  };
  signal: AbortSignal;
  inventory?: NoteMetadata[];
  report: string;
  apply: boolean;
  log?: (record: unknown) => void;
  fetchTranscript?: typeof fetchOfficialVtt;
}) {
  const { root, queue, store, signal } = input;
  // Even the read-only audit holds the runner lock: an inventory must not race a publisher.
  await access(join(root, 'paused'));
  if (
    queue.db
      .prepare('SELECT 1 FROM jobs WHERE lease_token IS NOT NULL LIMIT 1')
      .get() ||
    queue.db
      .prepare("SELECT 1 FROM sessions WHERE state!='deleted' LIMIT 1")
      .get()
  )
    throw new Error(
      'Language audit requires reconciled jobs and no live model sessions.',
    );
  let inventory = input.inventory;
  if (!inventory) {
    inventory = [];
    for (let after = '0'; ;) {
      const page = await store.listMetadata(after, 500);
      if (!page.length) break;
      inventory.push(...page);
      after = page.at(-1)!.shiurId;
    }
  }
  const report = {
    policy: NOTES_LANGUAGE_POLICY,
    at: Date.now(),
    published: inventory.length,
    checked: 0,
    drafts: 0,
    englishOrMixed: 0,
    findings: [] as LanguageFinding[],
    errors: [] as { id: string; reason: string }[],
    queued: 0,
    archive: null as string | null,
  };
  await mkdir(join(root, 'audits'), { recursive: true, mode: 0o700 });
  const checkpoint = () =>
    durableWrite(input.report, JSON.stringify(report, null, 2));
  async function localNote(
    meta: NoteMetadata,
  ): Promise<{ note: SavedNote; path: string | null }> {
    const job = queue.db
      .prepare('SELECT * FROM jobs WHERE id=?')
      .get(meta.shiurId) as NoteJob | undefined;
    if (job?.notes_hash === meta.notesHash && job.artifact_path) {
      const result = await loadArtifact(root, job.artifact_path);
      if (matchesMetadata(result.note, meta))
        return { note: result.note, path: job.artifact_path };
    }
    const folder = join(root, 'notes', meta.shiurId);
    const legacy = await readFile(join(folder, 'metadata.json'), 'utf8').catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      },
    );
    if (legacy) {
      const metadata = JSON.parse(legacy) as NoteMetadata;
      if (matchesMetadata(metadata, meta)) {
        const note = {
          ...metadata,
          gzip: new Uint8Array(await readFile(join(folder, 'notes.md.gz'))),
        };
        await unpackNote(note);
        return { note, path: null };
      }
    }
    // Older published checkpoints can remain local after a queue epoch changes.
    const base = join(
      'artifacts',
      meta.shiurId,
      meta.sourceHash,
      meta.generatorVersion,
    );
    for (const attempt of await readdir(statePath(root, base)).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return [];
        throw e;
      },
    )) {
      if (attempt.endsWith('.partial')) continue;
      const path = join(base, attempt),
        { note } = await loadArtifact(root, path);
      if (matchesMetadata(note, meta)) return { note, path };
    }
    const note = await store.get(meta.shiurId);
    if (!note || !matchesMetadata(note, meta))
      throw new Error('Published row changed since inventory.');
    return { note, path: null };
  }
  async function inspect(
    note: SavedNote,
    path: string | null,
    scope: LanguageFinding['scope'],
  ) {
    signal.throwIfAborted();
    const markdown = await unpackNote(note);
    if (!hebrewNotesBody(markdown)) {
      report.englishOrMixed++;
      return;
    }
    let source: Source | null = null,
      text = '',
      originalSource = false,
      sourceError: string | undefined;
    const sourcePath = join('sources', note.shiurId, note.sourceHash + '.vtt');
    try {
      const bytes = await readFile(statePath(root, sourcePath)).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        },
      );
      if (bytes) {
        if (digest(bytes) !== note.sourceHash)
          throw new Error('source_checksum_mismatch');
        text = transcriptText(bytes.toString('utf8'));
        source = {
          path: sourcePath,
          hash: note.sourceHash,
          bytes: bytes.length,
        };
        originalSource = true;
      } else {
        // HTTP only; never ask an AI to guess a missing transcript's language.
        const vtt = await (input.fetchTranscript ?? fetchOfficialVtt)(
          note.shiurId,
          signal,
        );
        await delay(250, undefined, { signal });
        if (!vtt) throw new Error('official_transcript_missing');
        text = transcriptText(vtt);
        source = await pinSource(root, note.shiurId, vtt);
        originalSource = source.hash === note.sourceHash;
      }
      if (!text.trim()) throw new Error('empty_transcript');
    } catch (error) {
      signal.throwIfAborted();
      sourceError =
        error instanceof Error ? error.message : 'source_unavailable';
      text = '';
      source = null;
    }
    const assessment = assessNotesLanguage(markdown, text);
    // A changed source cannot prove what the original lecturer spoke. Send it for a fresh generation too.
    const verdict =
      !source || !originalSource
        ? 'language_source_unavailable'
        : assessment.unexpectedHebrew
          ? 'unexpected_hebrew'
          : 'hebrew_source';
    if (!path) {
      path = join(
        'artifacts',
        note.shiurId,
        note.sourceHash,
        note.generatorVersion,
        'language-audit-' + note.notesHash,
      );
      await loadArtifact(root, path).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
        return saveArtifact(root, path!, note, {
          profile: note.generatorVersion,
          generator: 'language-audit:preserved-published-bytes',
          route: 'existing',
          review: 'published',
          attempt: 'language-audit',
        });
      });
    }
    report.findings.push({
      id: note.shiurId,
      notesHash: note.notesHash,
      sourceHash: note.sourceHash,
      scope,
      verdict,
      artifactPath: path,
      source,
      originalSource,
      assessment,
      ...(sourceError ? { sourceError } : {}),
    });
  }
  for (const meta of inventory) {
    signal.throwIfAborted();
    try {
      const { note, path } = await localNote(meta);
      await inspect(note, path, 'published');
      report.checked++;
    } catch (error) {
      signal.throwIfAborted();
      report.errors.push({
        id: meta.shiurId,
        reason: error instanceof Error ? error.message : 'audit_failed',
      });
    }
    if ((report.checked + report.errors.length) % 100 === 0) {
      await checkpoint();
      input.log?.({
        auditChecked: report.checked,
        candidates: report.findings.length,
        errors: report.errors.length,
      });
    }
  }
  for (const job of queue.db
    .prepare(
      "SELECT * FROM jobs WHERE artifact_path IS NOT NULL AND status IN ('generated','publishing','needs_review','conflict')",
    )
    .all() as NoteJob[]) {
    if (
      inventory.some(
        (meta) => meta.shiurId === job.id && meta.notesHash === job.notes_hash,
      )
    )
      continue;
    try {
      const { note } = await loadArtifact(root, job.artifact_path!);
      await inspect(note, job.artifact_path, 'draft');
      report.drafts++;
    } catch (error) {
      report.errors.push({
        id: job.id,
        reason: error instanceof Error ? error.message : 'draft_audit_failed',
      });
    }
  }
  await checkpoint();
  if (input.apply) {
    if (report.errors.length)
      throw new Error(
        'Audit incomplete; inspect report errors before applying.',
      );
    // Check every current public candidate before mutating any checkpoint.
    for (const finding of report.findings.filter(
      (f) => f.scope === 'published' && f.verdict !== 'hebrew_source',
    )) {
      const current = await store.get(finding.id);
      if (
        !current ||
        current.notesHash !== finding.notesHash ||
        current.sourceHash !== finding.sourceHash
      )
        throw new Error('Public candidate changed; rerun audit.');
    }
    const archive = join(root, 'audits', 'language-redo-' + report.at);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    queue.db.prepare('VACUUM INTO ?').run(join(archive, 'queue.sqlite'));
    report.archive = archive;
    await durableWrite(
      join(archive, 'audit.json'),
      JSON.stringify(report, null, 2),
    );
    for (const finding of report.findings) {
      if (finding.verdict === 'hebrew_source') {
        queue.db
          .prepare(
            `INSERT OR IGNORE INTO language_findings(job_id,notes_hash,source_hash,policy,scope,verdict,assessment,artifact_path,detected_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            finding.id,
            finding.notesHash,
            finding.sourceHash,
            NOTES_LANGUAGE_POLICY,
            finding.scope,
            finding.verdict,
            JSON.stringify(finding),
            finding.artifactPath,
            report.at,
          );
      } else if (queueLanguageRedo(queue, finding)) report.queued++;
    }
    await checkpoint();
  }
  input.log?.({
    published: report.published,
    checked: report.checked,
    drafts: report.drafts,
    hebrewSource: report.findings.filter((f) => f.verdict === 'hebrew_source')
      .length,
    unexpectedHebrew: report.findings.filter(
      (f) => f.verdict === 'unexpected_hebrew',
    ).length,
    sourceUnavailable: report.findings.filter(
      (f) => f.verdict === 'language_source_unavailable',
    ).length,
    errors: report.errors.length,
    queued: report.queued,
    report: input.report,
  });
  return report;
}
