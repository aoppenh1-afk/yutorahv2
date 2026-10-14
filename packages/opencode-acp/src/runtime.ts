import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ACPClient, type Launch } from './client.js';
import { runProcess, terminateOwnedWorkspace } from './process.js';
import { messageEvidence } from './evidence.js';
import { PipelineFailure } from '../../notes-only/src/control.js';
import { durableWrite } from '../../notes-only/src/artifacts.js';
import { Failure, failure, checkAbort } from './errors.js';

import { FREE_NOTES_MODEL, OPENCODE_VERSION } from './constants.js';
export { FREE_NOTES_MODEL, OPENCODE_VERSION } from './constants.js';
export type OpenCodeConfig = {
  executable: string;
  scratch: string;
  version?: string;
  onSession?: (id: string) => Promise<void>;
  onCleanup?: (ids: string[], deleted: boolean) => Promise<void>;
};
export const openCodeIdentity = (config: OpenCodeConfig) =>
  `opencode:${config.version ?? OPENCODE_VERSION}:notes-3-high`;

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Value)
    : {};
const rows = (value: unknown): Value[] =>
  Array.isArray(value) ? value.map(object) : [];

/** Native ACP transport, with a separate text-only provider policy. */
export class OpenCodeClient extends ACPClient {
  private deleted = false;
  private ownedSessions = new Set<string>();
  get sessionDeleted() {
    return this.deleted;
  }
  async verifiedPrompt(
    prompt: string,
    timeoutMs: number,
    capture?: (messages: unknown) => Promise<void>,
  ) {
    let text: string | undefined;
    let promptError: unknown;
    try {
      text = await this.textPrompt(prompt, timeoutMs);
    } catch (error) {
      promptError = error;
    }
    const exported = JSON.parse(
      (
        await runProcess(this.launch.executable, ['export', this.sessionId!], {
          cwd: this.launch.cwd,
          env: this.launch.env,
          signal: AbortSignal.timeout(30_000),
          maxBytes: 16 * 1024 * 1024,
          timeoutMs: 30_000,
        })
      ).toString(),
    );
    await capture?.(exported.messages);
    if (promptError) {
      try {
        messageEvidence(exported.messages ?? [], this.sessionId!);
      } catch (error) {
        if (
          error instanceof PipelineFailure &&
          ['paid_route', 'unconfirmed_identity'].includes(error.code)
        )
          throw error;
        if (error && typeof error === 'object' && 'status' in error)
          throw error;
      }
      throw promptError;
    }
    const evidence = messageEvidence(exported.messages ?? [], this.sessionId!);
    return { value: text!, evidence, messages: exported.messages };
  }
  constructor(
    launch: Launch,
    signal: AbortSignal,
    graceMs = 2000,
    onSession?: (id: string) => Promise<void>,
  ) {
    super(launch, signal, graceMs, onSession);
  }
  override async initialize(): Promise<Value> {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'yutorah-notes', version: '0.1.0' },
    });
    const agent = object(result.agentInfo);
    if (
      result.protocolVersion !== 1 ||
      agent.name !== 'OpenCode' ||
      agent.version !== this.launch.version
    )
      throw new Failure('configuration');
    return result;
  }
  override async authenticate(): Promise<void> {
    // The native runtime owns provider credentials and its anonymous free lane.
  }
  override async session(
    cwd: string,
    model = FREE_NOTES_MODEL,
  ): Promise<string[]> {
    if (model !== FREE_NOTES_MODEL) throw new Failure('configuration');
    let result = await this.beginSession(cwd);
    this.deleted = false;
    this.ownedSessions.add(this.sessionId!);
    const select = async (id: string, value: string) => {
      const option = rows(result.configOptions).find((o) => o.id === id);
      if (!option || !rows(option.options).some((o) => o.value === value))
        throw new Failure('configuration');
      // Always set and verify rather than trusting a cached default model.
      result = await this.request('session/set_config_option', {
        sessionId: this.sessionId,
        configId: id,
        value,
      });
      if (
        rows(result.configOptions).find((o) => o.id === id)?.currentValue !==
        value
      )
        throw new Failure('configuration');
    };
    await select('mode', 'plan');
    await select('model', model);
    await select('effort', 'high');
    for (const [id, value] of [
      ['mode', 'plan'],
      ['model', model],
      ['effort', 'high'],
    ])
      if (
        rows(result.configOptions).find((o) => o.id === id)?.currentValue !==
        value
      )
        throw new Failure('configuration');
    return [model];
  }
  override async close(): Promise<void> {
    if (this.sessionId) this.ownedSessions.add(this.sessionId);
    await super.close();
    this.deleted = true;
    for (const sessionId of this.ownedSessions) {
      const deleted = await deleteOwnedSession(this.launch, sessionId);
      this.deleted = deleted && this.deleted;
    }
  }
}

export function notesAgentConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: FREE_NOTES_MODEL,
    small_model: FREE_NOTES_MODEL,
    default_agent: 'plan',
    enabled_providers: ['opencode'],
    // Zen rejects free requests when native tool definitions are disabled.
    // Keep the normal plan tools, require permission, and reject every tool
    // operation through ACPClient. The supplied skill/source need no tools.
    permission: { '*': 'ask', edit: 'deny', external_directory: 'deny' },
    share: 'disabled',
    autoupdate: false,
    agent: {
      plan: {
        model: FREE_NOTES_MODEL,
        variant: 'high',
      },
    },
  };
}

/** Each request gets an owned workspace, free-only config, and session cleanup. */
export async function withOpenCode<T>(
  config: OpenCodeConfig,
  signal: AbortSignal,
  operation: (client: OpenCodeClient, workspace: string) => Promise<T>,
): Promise<T> {
  checkAbort(signal);
  if (config.version && config.version !== OPENCODE_VERSION)
    throw new Failure('configuration');
  await mkdir(config.scratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(config.scratch, 'opencode-'));
  let client: OpenCodeClient | undefined;
  const ids: string[] = [];
  let result: T | undefined;
  let operationError: unknown;
  try {
    await mkdir(join(root, 'tmp'), { mode: 0o700 });
    // OpenCode resolves project config at the Git root. An owned empty repo
    // prevents scratch inside a checkout from inheriting that checkout's config.
    await runProcess('git', ['init', '--quiet', '--template=', root], {
      cwd: root,
      signal,
      maxBytes: 4096,
      timeoutMs: 10_000,
    }).catch((error) => {
      const e = failure(error);
      if (['cancelled', 'timeout'].includes(e.code)) throw e;
      throw new Failure('configuration');
    });
    await writeFile(
      join(root, 'opencode.json'),
      JSON.stringify(notesAgentConfig()),
      {
        mode: 0o600,
      },
    );
    client = new OpenCodeClient(
      launch(config, root),
      signal,
      2000,
      async (id) => {
        ids.push(id);
        await durableWrite(
          join(root, 'sessions.json'),
          JSON.stringify({ version: 1, ids }),
        );
        await config.onSession?.(id);
      },
    );
    const pid = client.runtimePid;
    if (!pid) throw new Failure('configuration');
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    await durableWrite(
      join(root, 'process.json'),
      JSON.stringify({
        pid,
        startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      }),
    );
    await client.initialize();
    result = await operation(client, root);
  } catch (error) {
    operationError = error;
  }
  try {
    try {
      await client?.close();
      await config.onCleanup?.(ids, !!client?.sessionDeleted);
    } finally {
      // Session IDs may need recovery, but all owned subprocesses have stopped.
      // Native libraries never need to survive with the session ledger.
      await rm(join(root, 'tmp'), { recursive: true, force: true });
      // Keep the ID ledger when cancellation/crash prevents an acknowledged
      // deletion. The next notes-worker start removes that owned session first.
      if (!ids.length || client?.sessionDeleted)
        await rm(root, { recursive: true, force: true });
      else
        operationError = new PipelineFailure(
          'session_uncertain',
          'muse',
          0,
          true,
        );
    }
  } catch (error) {
    operationError = error;
  }
  if (operationError) throw operationError;
  return result as T;
}

function launch(config: OpenCodeConfig, root: string): Launch {
  if (config.version && config.version !== OPENCODE_VERSION)
    throw new Failure('configuration');
  return {
    executable: config.executable,
    args: ['acp'],
    cwd: root,
    version: config.version ?? OPENCODE_VERSION,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: join(root, 'tmp'),
      BUN_TMPDIR: join(root, 'tmp'),
      NODE_ENV: 'production',
      LANG: 'C.UTF-8',
      // Keep user-installed agents/plugins out of this owned notes workspace.
      // The data directory stays native so provider authentication still works.
      XDG_CONFIG_HOME: join(root, 'config'),
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_CONFIG: join(root, 'opencode.json'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(notesAgentConfig()),
    },
  };
}

/** Stable OpenCode exposes deletion through its CLI, not ACP session/delete. */
async function deleteOwnedSession(
  launch: Launch,
  id: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return false;
  return runProcess(launch.executable, ['session', 'delete', id], {
    cwd: launch.cwd,
    env: launch.env,
    signal: new AbortController().signal,
    maxBytes: 4096,
    timeoutMs: 15_000,
  }).then(
    () => true,
    () => false,
  );
}

export async function recoverOpenCode(
  config: OpenCodeConfig,
  root: string,
  signal: AbortSignal,
): Promise<void> {
  await terminateOwnedWorkspace(root, 'process.json');
  await rm(join(root, 'tmp'), { recursive: true, force: true });
  await mkdir(join(root, 'tmp'), { mode: 0o700 });
  const text = await readFile(join(root, 'sessions.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (text) {
    let value: { version: number; ids: string[] };
    try {
      value = JSON.parse(text);
    } catch {
      throw new Failure('configuration');
    }
    if (
      value.version !== 1 ||
      !Array.isArray(value.ids) ||
      value.ids.length > 20 ||
      value.ids.some(
        (id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id),
      )
    )
      throw new Failure('configuration');
    const command = launch(config, root);
    const client = new OpenCodeClient(command, signal);
    try {
      await client.initialize();
    } finally {
      await client.close();
    }
    for (const id of value.ids)
      if (!(await deleteOwnedSession(command, id)))
        throw new Failure('configuration');
  }
  await rm(root, { recursive: true, force: true });
}
