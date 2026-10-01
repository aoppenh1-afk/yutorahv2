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

export type OperatorConfig = {
  runtime: RuntimeConfig;
  transcriptionSkillPath: string;
  notesSkillPath: string;
  concurrency: number;
  intervalMs: number;
};
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
  private readonly selections: SelectionStore;
  constructor(
    private readonly store: TranscriptionStore,
    private readonly config: OperatorConfig,
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
    let scratchBytes = 0;
    const size = async (path: string): Promise<void> => {
      for (const file of await readdir(path, { withFileTypes: true }).catch(
        () => [],
      )) {
        const full = join(path, file.name);
        if (file.isDirectory()) await size(full);
        else if (file.isFile())
          scratchBytes += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
    };
    await size(this.config.runtime.scratch);
    return {
      state: this.state,
      error: this.error,
      runtimeInstalled: installed,
      connected: this.connected,
      models: this.models,
      authUrl: this.authUrl,
      authPort: this.authPort,
      scratchBytes,
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
  async start() {
    if (this.work) return;
    if (this.authWork) throw new Failure('configuration');
    const targets = await this.selections.targets();
    if (!targets.some((t) => t.enabled)) throw new Failure('configuration');
    const settings = await this.selections.settings();
    const p = await this.currentProfile();
    const notes = settings.notes_enabled
      ? notesProfile({
          model: settings.model,
          language: p.settings.language,
          runtime: p.runtime,
          transcriptionSkill: p.skill,
          notesSkill: await readFile(this.config.notesSkillPath, 'utf8'),
        })
      : undefined;
    await this.selections.saveSettings({ ...settings, worker_enabled: true });
    this.workAbort = new AbortController();
    this.error = null;
    this.state = 'starting';
    this.work = runWorker(
      this.store,
      {
        runtime: this.config.runtime,
        concurrency: this.config.concurrency,
        pollMs: 1000,
        model: settings.model,
        selectedOnly: true,
        notes,
        catalog: {
          profile: p,
          intervalMs: this.config.intervalMs,
          deepIntervalMs: this.config.intervalMs,
        },
        onReady: (models) => {
          this.state = 'running';
          this.connected = true;
          this.models = models;
        },
      },
      this.workAbort.signal,
    )
      .catch((error) => {
        if (!this.workAbort?.signal.aborted) {
          this.state = 'error';
          this.error = failure(error).code;
          if (this.error === 'auth_required') this.connected = false;
        }
      })
      .finally(() => {
        this.work = undefined;
        if (this.state !== 'error') this.state = 'stopped';
      });
  }
  async stop(persist = true) {
    this.workAbort?.abort(new Failure('cancelled'));
    await this.work;
    if (persist)
      await this.selections.saveSettings({
        ...(await this.selections.settings()),
        worker_enabled: false,
      });
    if (!this.authWork) this.state = 'stopped';
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
    await this.cancelAuth();
    await this.stop(false);
  }
}
