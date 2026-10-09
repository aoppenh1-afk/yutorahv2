import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { ACPClient, type Launch } from '../../antigravity-acp/src/client.js';
import { runProcess } from '../../antigravity-acp/src/process.js';
import {
  Failure,
  failure,
  checkAbort,
} from '../../antigravity-acp/src/errors.js';

export const FREE_NOTES_MODEL = 'opencode/muse-spark-1.3-contributor-free';
export const OPENCODE_VERSION = '1.18.33';
export type OpenCodeConfig = {
  executable: string;
  scratch: string;
  version?: string;
};
export const openCodeIdentity = (config: OpenCodeConfig) =>
  `opencode:${config.version ?? OPENCODE_VERSION}:notes-2`;

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
  constructor(
    launch: Launch,
    signal: AbortSignal,
    graceMs = 2000,
    onSession?: (id: string) => Promise<void>,
  ) {
    super(launch, signal, undefined, graceMs, onSession);
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
  try {
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
        await writeFile(
          join(root, 'sessions.json.next'),
          JSON.stringify({ version: 1, ids }),
          { mode: 0o600 },
        );
        await rename(
          join(root, 'sessions.json.next'),
          join(root, 'sessions.json'),
        );
      },
    );
    await client.initialize();
    return await operation(client, root);
  } finally {
    try {
      await client?.close();
    } finally {
      // Keep the ID ledger when cancellation/crash prevents an acknowledged
      // deletion. The next notes-worker start removes that owned session first.
      if (!ids.length || client?.sessionDeleted)
        await rm(root, { recursive: true, force: true });
    }
  }
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
