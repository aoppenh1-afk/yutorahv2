import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import {
  Failure,
  failure,
} from '../../../packages/antigravity-acp/src/errors.js';
import {
  withRuntime,
  type RuntimeConfig,
} from '../../../packages/antigravity-acp/src/runtime.js';
import {
  profile,
  type TranscriptionStore,
} from '../../../packages/transcription/src/store.js';
import { notesProfile } from '../../../packages/transcription/src/notes.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';
import { SelectionStore, scanSelections } from './selections.js';
import { runWorker, runtimeIdentity } from './worker.js';
import type { SessionPool } from '../../../packages/antigravity-acp/src/pool.js';
import {
  FREE_NOTES_MODEL,
  openCodeIdentity,
  type OpenCodeConfig,
} from '../../../packages/opencode-acp/src/runtime.js';
import { runNotesWorker, type NotesWorkerStatus } from './notes-worker.js';

export type OperatorConfig = {
  runtime: RuntimeConfig;
  transcriptionSkillPath: string;
  notesSkillPath: string;
  concurrency: number;
  intervalMs: number;
  openCode?: OpenCodeConfig;
  notesConcurrency?: number;
};
export const quotaResumeDelayMs = (5 * 60 + 1) * 60_000;
export class OperatorRuntime {
  private work?: Promise<void>;
  private workAbort?: AbortController;
  private authWork?: Promise<void>;
  private authAbort?: AbortController;
  private state = 'stopped';
  private error: string | null = null;
  private authUrl: string | null = null;
  private authPort: number | null = null;
  private models: string[] = [];
  private connected = false;
  private changing = false;
  private closed = false;
  private resumeTimer?: NodeJS.Timeout;
  private resumeAt: Date | null = null;
  private sessions?: SessionPool;
  private notesWork?: Promise<void>;
  private notesAbort?: AbortController;
  private notesStatus?: NotesWorkerStatus;
  private readonly selections: SelectionStore;
  constructor(
    private readonly store: TranscriptionStore,
    private readonly config: OperatorConfig,
    private readonly worker: typeof runWorker = runWorker,
    private readonly notesWorker: typeof runNotesWorker = runNotesWorker,
  ) {
    this.selections = new SelectionStore(store.pool);
  }
  async status() {
    const installed = await access(
      join(this.config.runtime.directory, 'agy_acp_server.par'),
      constants.X_OK,
    ).then(
      () => true,
      () => false,
    );
    const size = async (path: string): Promise<number> => {
      let bytes = 0;
      for (const file of await readdir(path, { withFileTypes: true }).catch(
        () => [],
      )) {
        const full = join(path, file.name);
        if (file.isDirectory()) bytes += await size(full);
        else if (file.isFile())
          bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
      return bytes;
    };
    const scratchBytes = await size(this.config.runtime.scratch);
    const conversationBytes =
      (await size(
        join(this.config.runtime.profile, 'antigravity-acp/conversations'),
      )) +
      (await size(join(this.config.runtime.profile, 'antigravity-acp/brain')));
    return {
      state: this.state,
      error: this.error,
      runtimeInstalled: installed,
      connected: this.connected,
      models: this.models,
      authUrl: this.authUrl,
      authPort: this.authPort,
      scratchBytes,
      conversationBytes,
      concurrency: this.config.concurrency,
      activeSessions: this.sessions?.activeCount ?? 0,
      resumeAt: this.resumeAt?.toISOString() ?? null,
      notes: this.notesStatus ?? null,
    };
  }
  async currentProfile() {
    const settings = await this.selections.settings();
    const skill = await readFile(this.config.transcriptionSkillPath, 'utf8');
    return profile(
      skill,
      { ...defaultSettings, model: settings.model },
      runtimeIdentity(),
    );
  }
  async scan(pages = 2) {
    if (!Number.isInteger(pages) || pages < 1 || pages > 10)
      throw new Failure('configuration');
    const p = await this.currentProfile();
    if (
      !this.connected ||
      this.authWork ||
      !this.models.includes(p.settings.model)
    )
      throw new Failure('configuration');
    return scanSelections(this.store, p, AbortSignal.timeout(120_000), pages);
  }
  /** Restore the user's running intent without retrying an exhausted quota early. */
  async restore() {
    const settings = await this.selections.settings();
    if (!settings.worker_enabled) return;
    await this.startNotes();
    if (
      settings.quota_resume_at &&
      settings.quota_resume_at.getTime() > Date.now()
    ) {
      this.resumeAt = settings.quota_resume_at;
      this.state = 'waiting_quota';
      this.error = 'quota_exhausted';
      this.armQuotaResume();
    } else {
      await this.start();
    }
  }
  private clearResumeTimer() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
  }
  private armQuotaResume(minimumDelayMs = 0) {
    this.clearResumeTimer();
    if (this.closed || !this.resumeAt) return;
    this.resumeTimer = setTimeout(
      () => {
        this.resumeTimer = undefined;
        if (this.closed || !this.resumeAt) return;
        // A manual control operation owns the next state change. Check again
        // after it finishes; pause or sign-in will cancel this timer entirely.
        if (this.changing || this.authWork || this.work) {
          this.armQuotaResume(1000);
          return;
        }
        void this.change(() => this.start()).catch((error) => {
          this.state = 'error';
          this.error = failure(error).code;
        });
      },
      Math.max(minimumDelayMs, this.resumeAt.getTime() - Date.now(), 0),
    );
    this.resumeTimer.unref();
  }
  async start() {
    if (this.closed) throw new Failure('configuration');
    if (this.work) return;
    if (this.authWork) throw new Failure('configuration');
    if (!(await this.selections.hasEnabledTarget()))
      throw new Failure('configuration');
    const settings = await this.selections.settings();
    await this.startNotes();
    const p = await this.currentProfile();
    const notes = settings.notes_enabled
      ? notesProfile({
          model: this.config.openCode ? FREE_NOTES_MODEL : settings.model,
          language: p.settings.language,
          runtime: this.config.openCode
            ? openCodeIdentity(this.config.openCode)
            : p.runtime,
          transcriptionSkill: p.skill,
          notesSkill: await readFile(this.config.notesSkillPath, 'utf8'),
        })
      : undefined;
    const notesError = this.notesStatus?.error;
    if (notesError === 'storage_exhausted' || notesError === 'lease_lost')
      throw new Failure(notesError);
    this.clearResumeTimer();
    await this.selections.saveSettings({ ...settings, worker_enabled: true });
    await this.selections.setQuotaResume(null);
    this.resumeAt = null;
    this.workAbort = new AbortController();
    this.error = null;
    this.state = 'starting';
    let quotaDetectedAt: number | undefined;
    this.work = this.worker(
      this.store,
      {
        runtime: this.config.runtime,
        concurrency: this.config.concurrency,
        pollMs: 1000,
        model: settings.model,
        selectedOnly: true,
        notes,
        openCode: this.config.openCode,
        onQuotaExhausted: () => {
          quotaDetectedAt ??= Date.now();
        },
        catalog: {
          profile: p,
          intervalMs: this.config.intervalMs,
          deepIntervalMs: this.config.intervalMs,
        },
        onReady: (models, pool) => {
          this.state = 'running';
          this.connected = true;
          this.models = models;
          this.sessions = pool;
        },
      },
      this.workAbort.signal,
    )
      .catch(async (error) => {
        if (!this.workAbort?.signal.aborted) {
          this.state = 'error';
          this.error = failure(error).code;
          if (this.error === 'auth_required') this.connected = false;
          if (this.error === 'quota_exhausted') {
            const deadline = new Date(
              (quotaDetectedAt ?? Date.now()) + quotaResumeDelayMs,
            );
            try {
              this.resumeAt = await this.selections.setQuotaResume(deadline);
              if (this.resumeAt) this.state = 'waiting_quota';
            } catch (saveError) {
              this.error = failure(saveError).code;
            }
          }
        }
      })
      .finally(() => {
        this.work = undefined;
        if (this.state === 'waiting_quota') this.armQuotaResume();
        else if (this.state !== 'error') this.state = 'stopped';
      });
  }
  async stop(persist = true) {
    this.clearResumeTimer();
    this.workAbort?.abort(new Failure('cancelled'));
    this.notesAbort?.abort(new Failure('cancelled'));
    await Promise.all([this.work, this.notesWork]);
    this.clearResumeTimer();
    if (persist)
      await this.selections.saveSettings({
        ...(await this.selections.settings()),
        worker_enabled: false,
      });
    this.resumeAt = null;
    if (persist && this.error === 'quota_exhausted') this.error = null;
    if (!this.authWork) this.state = 'stopped';
  }
  private async startNotes() {
    if (this.closed || this.notesWork || !this.config.openCode) return;
    const settings = await this.selections.settings();
    if (!settings.notes_enabled) {
      this.notesStatus = undefined;
      return;
    }
    const p = await this.currentProfile();
    const notes = notesProfile({
      model: FREE_NOTES_MODEL,
      language: p.settings.language,
      runtime: openCodeIdentity(this.config.openCode),
      transcriptionSkill: p.skill,
      notesSkill: await readFile(this.config.notesSkillPath, 'utf8'),
    });
    this.notesAbort = new AbortController();
    this.notesStatus = {
      state: 'starting',
      model: notes.model,
      concurrency: this.config.notesConcurrency ?? 2,
      activeSessions: 0,
      resumeAt: null,
      error: null,
    };
    this.notesWork = this.notesWorker(
      this.store,
      {
        runtime: this.config.runtime,
        openCode: this.config.openCode,
        notes,
        concurrency: this.config.notesConcurrency ?? 2,
        pollMs: 5000,
        selectedOnly: true,
        onStatus: (status) => {
          this.notesStatus = status;
        },
      },
      this.notesAbort.signal,
    )
      .catch((error) => {
        if (!this.notesAbort?.signal.aborted && this.notesStatus) {
          const e = failure(error);
          this.notesStatus = {
            ...this.notesStatus,
            state: 'error',
            error: e.code,
          };
          if (e.code === 'storage_exhausted' || e.code === 'lease_lost') {
            this.workAbort?.abort(e);
            this.state = 'error';
            this.error = e.code;
          }
        }
      })
      .finally(() => {
        this.notesWork = undefined;
      });
  }
  async authenticate(interactive: boolean) {
    if (this.authWork) return;
    await this.stop();
    this.state = 'authenticating';
    this.error = null;
    this.authUrl = null;
    this.authPort = null;
    this.authAbort = new AbortController();
    this.authWork = withRuntime(
      {
        ...this.config.runtime,
        scratch: join(this.config.runtime.scratch, 'auth'),
      },
      this.authAbort.signal,
      async (client, workspace) => {
        await client.authenticate();
        this.models = await client.session(workspace);
        this.connected = true;
      },
      interactive
        ? (value) => {
            this.authUrl = value.url.href;
            this.authPort = value.port;
          }
        : undefined,
    )
      .catch((error) => {
        this.error = failure(error).code;
        this.connected = false;
      })
      .finally(() => {
        this.authWork = undefined;
        this.authUrl = null;
        this.authPort = null;
        this.state = this.error ? 'error' : 'stopped';
      });
  }
  async cancelAuth() {
    this.authAbort?.abort(new Failure('cancelled'));
    await this.authWork;
  }
  /** Serialize control operations so two clicks cannot start competing workers. */
  async change(action: () => Promise<unknown>) {
    if (this.changing) throw new Failure('configuration');
    this.changing = true;
    try {
      return await action();
    } finally {
      this.changing = false;
    }
  }
  async close() {
    this.closed = true;
    this.clearResumeTimer();
    await this.cancelAuth();
    await this.stop(false);
  }
}
