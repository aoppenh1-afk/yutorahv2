import { OwnedProcess } from './process.js';
import { Failure, abortReason, checkAbort } from './errors.js';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as ObjectValue)
    : {};
const rows = (v: unknown): ObjectValue[] =>
  Array.isArray(v) ? v.map(object) : [];

export function authorizationURL(value: string): { url: URL; port: number } {
  if (value.length > 16_384) throw new Failure('auth_required');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Failure('auth_required');
  }
  const params = url.searchParams;
  const state = params.getAll('state');
  const redirects = params.getAll('redirect_uri');
  const response = params.getAll('response_type');
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'accounts.google.com' ||
    url.port ||
    url.pathname !== '/o/oauth2/v2/auth' ||
    url.username ||
    url.password ||
    url.hash ||
    state.length !== 1 ||
    !state[0] ||
    state[0].length > 512 ||
    /\s/.test(state[0]) ||
    redirects.length !== 1 ||
    response.length !== 1 ||
    response[0] !== 'code'
  )
    throw new Failure('auth_required');
  let redirect: URL;
  try {
    redirect = new URL(redirects[0]);
  } catch {
    throw new Failure('auth_required');
  }
  const port = Number(redirect.port);
  if (
    redirect.protocol !== 'http:' ||
    redirect.hostname !== '127.0.0.1' ||
    redirect.pathname !== '/' ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    port < 1024 ||
    port > 65535
  )
    throw new Failure('auth_required');
  return { url, port };
}

/** Byte framing preserves split UTF-8. Oversized lines are never retained. */
export class Lines {
  private buffer = Buffer.alloc(0);
  private dropping = false;
  constructor(
    private max: number,
    private line: (s: string) => void,
    private exceeded: () => void,
  ) {}
  push(data: Buffer): void {
    let begin = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 10) continue;
      this.append(data.subarray(begin, i));
      if (!this.dropping && this.buffer.length)
        this.line(this.buffer.toString('utf8'));
      this.buffer = Buffer.alloc(0);
      this.dropping = false;
      begin = i + 1;
    }
    this.append(data.subarray(begin));
  }
  private append(data: Buffer) {
    if (this.dropping) return;
    if (this.buffer.length + data.length > this.max) {
      this.buffer = Buffer.alloc(0);
      this.dropping = true;
      this.exceeded();
    } else if (data.length) this.buffer = Buffer.concat([this.buffer, data]);
  }
}

export type Launch = {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
};
export class ACPClient {
  private owned: OwnedProcess;
  private pending = new Map<
    number,
    {
      resolve: (r: ObjectValue) => void;
      reject: (e: Failure) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private nextId = 1;
  private error?: Failure;
  private denying = false;
  private sessionId?: string;
  private output: string[] = [];
  private outputBytes = 0;
  private abort: () => void;
  readonly diagnostics = {
    protocolMessages: 0,
    messageChunks: 0,
    thoughtChunks: 0,
    stderrBytes: 0,
  };

  constructor(
    private launch: Launch,
    private signal: AbortSignal,
    private onAuthorization?: (value: { url: URL; port: number }) => void,
    private graceMs = 2000,
    private onSession?: (id: string) => Promise<void>,
  ) {
    checkAbort(signal);
    this.owned = new OwnedProcess(
      launch.executable,
      launch.args,
      launch.cwd,
      launch.env,
    );
    this.abort = () => {
      if (this.sessionId)
        this.send({
          jsonrpc: '2.0',
          method: 'session/cancel',
          params: { sessionId: this.sessionId },
        });
      this.fail(abortReason(signal));
    };
    signal.addEventListener('abort', this.abort, { once: true });
    const stdout = new Lines(
      8 * 1024 * 1024,
      (line) => this.handleLine(line),
      () => this.fail(new Failure('output_limit')),
    );
    const stderr = new Lines(
      16_512,
      (line) => {
        this.handleAuth(line);
      },
      () => {},
    );
    this.owned.child.stdout.on('data', (data: Buffer) => stdout.push(data));
    this.owned.child.stderr.on('data', (data: Buffer) => {
      this.diagnostics.stderrBytes += data.length;
      stderr.push(data);
    });
    this.owned.child.stdin.on('error', () =>
      this.fail(new Failure('process_exit')),
    );
    this.owned.child.once('error', () =>
      this.fail(new Failure('process_exit')),
    );
    this.owned.child.once('exit', () => this.fail(new Failure('process_exit')));
  }
  async initialize(): Promise<ObjectValue> {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'yutorah-worker',
        title: 'YU Torah transcription',
        version: '0.1.0',
      },
    });
    const identity = object(result.agentInfo);
    if (
      result.protocolVersion !== 1 ||
      identity.name !== 'antigravity-acp' ||
      identity.version !== this.launch.version ||
      object(object(result.agentCapabilities).promptCapabilities).audio !==
        true ||
      !rows(result.authMethods).some((m) => m.id === 'oauth-personal')
    )
      throw new Failure('configuration');
    return result;
  }
  async authenticate(): Promise<void> {
    await this.request(
      'authenticate',
      { methodId: 'oauth-personal' },
      this.onAuthorization ? 300_000 : 90_000,
    );
  }
  async session(cwd: string, model?: string): Promise<string[]> {
    const result = await this.request('session/new', { cwd, mcpServers: [] });
    if (typeof result.sessionId !== 'string' || !result.sessionId)
      throw new Failure('protocol');
    this.sessionId = result.sessionId;
    await this.onSession?.(this.sessionId);
    const modes = rows(object(result.modes).availableModes).map((m) => m.id);
    if (modes.length && !modes.includes('default'))
      throw new Failure('configuration');
    if (modes.includes('default'))
      await this.request('session/set_mode', {
        sessionId: this.sessionId,
        modeId: 'default',
      });
    const options = rows(result.configOptions);
    const selector = (category: string) =>
      options.find((o) => o.category === category) ??
      options.find((o) => o.id === category);
    const values = (option?: ObjectValue): string[] =>
      rows(option?.options).flatMap((o) =>
        typeof o.value === 'string'
          ? [o.value]
          : rows(o.options)
              .map((v) => v.value)
              .filter((v): v is string => typeof v === 'string'),
      );
    const modelOption = selector('model');
    const models = values(modelOption);
    if (model) {
      if (!modelOption || !models.includes(model))
        throw new Failure('configuration');
      if (modelOption.currentValue !== model)
        await this.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: modelOption.id ?? modelOption.configId,
          value: model,
        });
      const effort = model.match(/-(low|medium|high)$/)?.[1] ?? 'high';
      const thought = selector('thought_level');
      if (
        thought &&
        values(thought).includes(effort) &&
        thought.currentValue !== effort
      ) {
        await this.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: thought.id ?? thought.configId,
          value: effort,
        });
      }
    }
    return models;
  }
  async prompt(
    text: string,
    audio: Buffer,
    mimeType: string,
    timeoutMs: number,
  ): Promise<string> {
    if (
      audio.length > 20 * 1024 * 1024 ||
      !audio.length ||
      Buffer.byteLength(text) > 1024 * 1024
    )
      throw new Failure('configuration');
    return this.sendPrompt(
      [
        { type: 'text', text },
        { type: 'audio', data: audio.toString('base64'), mimeType },
      ],
      timeoutMs,
    );
  }
  /** Generation uses the same deny-tools policy as native audio transcription. */
  async textPrompt(text: string, timeoutMs = 900_000): Promise<string> {
    if (!text.trim() || Buffer.byteLength(text) > 1024 * 1024)
      throw new Failure('configuration');
    return this.sendPrompt([{ type: 'text', text }], timeoutMs);
  }
  private async sendPrompt(
    prompt: ObjectValue[],
    timeoutMs: number,
  ): Promise<string> {
    if (!this.sessionId) throw new Failure('protocol');
    this.output = [];
    this.outputBytes = 0;
    const result = await this.request(
      'session/prompt',
      {
        sessionId: this.sessionId,
        prompt,
      },
      timeoutMs,
    );
    if (this.error) throw this.error;
    if (result.stopReason !== 'end_turn')
      throw new Failure('incomplete_output');
    return this.output
      .join('')
      .split('\n')
      .filter(
        (l) =>
          !(l.trim().startsWith('Warning:') && /skill/i.test(l)) &&
          !l.trim().startsWith('⚠'),
      )
      .join('\n')
      .trim();
  }
  request(
    method: string,
    params: ObjectValue,
    timeoutMs = 90_000,
  ): Promise<ObjectValue> {
    if (this.error) return Promise.reject(this.error);
    checkAbort(this.signal);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Failure('timeout')),
        timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.abort);
    this.fail(new Failure('process_exit'));
    await this.owned.stop(this.graceMs);
    this.output = [];
  }
  private send(value: ObjectValue, after?: () => void) {
    if (this.error) {
      after?.();
      return;
    }
    this.owned.child.stdin.write(JSON.stringify(value) + '\n', (err) => {
      if (err) this.fail(new Failure('process_exit'));
      after?.();
    });
  }
  private fail(error: Failure) {
    if (this.error) return;
    this.error = error;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    void this.owned.stop(this.graceMs);
  }
  private handleAuth(line: string): boolean {
    const prefix = [
      'Open the following link to authenticate the ACP server: ',
      '__YUTORAH_AUTH_URL__',
      '__LECTERN_ANTIGRAVITY_AUTH_URL__',
    ].find((p) => line.startsWith(p));
    if (!prefix) return false;
    try {
      const value = authorizationURL(line.slice(prefix.length).trim());
      if (!this.onAuthorization) throw new Failure('auth_required');
      this.onAuthorization(value);
    } catch {
      this.fail(new Failure('auth_required'));
    }
    return true;
  }
  private handleLine(line: string) {
    if (this.error || this.denying || this.handleAuth(line)) return;
    let value: ObjectValue;
    try {
      value = object(JSON.parse(line));
    } catch {
      return;
    } // Native startup chrome is not JSON-RPC.
    this.diagnostics.protocolMessages++;
    if (value.jsonrpc !== '2.0') {
      this.fail(new Failure('protocol'));
      return;
    }
    if (value.method === undefined && typeof value.id === 'number') {
      const call = this.pending.get(value.id);
      if (!call) return;
      this.pending.delete(value.id);
      clearTimeout(call.timer);
      if (value.error) {
        const error = object(value.error);
        call.reject(
          new Failure(
            error.code === 401 || /auth|sign.?in/i.test(String(error.message))
              ? 'auth_required'
              : 'provider',
          ),
        );
      } else if (value.result !== undefined) call.resolve(object(value.result));
      else call.reject(new Failure('protocol'));
      return;
    }
    if (value.id !== undefined && typeof value.method === 'string') {
      const reply =
        value.method === 'session/request_permission'
          ? { result: { outcome: { outcome: 'cancelled' } } }
          : {
              error: {
                code: -32601,
                message: 'Transcription does not support tools or user input',
              },
            };
      // Ignore further output immediately, but allow the protocol denial to flush.
      this.denying = true;
      const timer = setTimeout(() => this.fail(new Failure('off_task')), 100);
      this.send({ jsonrpc: '2.0', id: value.id, ...reply }, () => {
        clearTimeout(timer);
        this.fail(new Failure('off_task'));
      });
      return;
    }
    if (value.method !== 'session/update') return;
    const params = object(value.params),
      update = object(params.update);
    if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      this.fail(new Failure('off_task'));
      return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      this.diagnostics.thoughtChunks++;
      return;
    }
    if (
      params.sessionId !== this.sessionId ||
      update.sessionUpdate !== 'agent_message_chunk'
    )
      return;
    const content = object(update.content);
    if (content.type !== 'text' || typeof content.text !== 'string') return;
    this.diagnostics.messageChunks++;
    this.outputBytes += Buffer.byteLength(content.text);
    if (this.outputBytes > 4 * 1024 * 1024) {
      this.fail(new Failure('output_limit'));
      return;
    }
    this.output.push(content.text);
  }
}
