import { OwnedProcess } from './process.js';
import { Failure, abortReason, checkAbort } from './errors.js';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as ObjectValue)
    : {};
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
export abstract class ACPClient {
  private owned: OwnedProcess;
  get runtimePid() {
    return this.owned.child.pid;
  }
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
  protected sessionId?: string;
  private output: string[] = [];
  private outputBytes = 0;
  private abort: () => void;
  readonly diagnostics = {
    protocolMessages: 0,
    messageChunks: 0,
    thoughtChunks: 0,
    thoughtBytes: 0,
    stderrBytes: 0,
  };

  constructor(
    protected launch: Launch,
    protected signal: AbortSignal,
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
  abstract initialize(): Promise<ObjectValue>;
  abstract authenticate(): Promise<void>;
  abstract session(cwd: string, model?: string): Promise<string[]>;
  /** Shared framing and session ownership; each provider validates its own policy. */
  protected async beginSession(cwd: string): Promise<ObjectValue> {
    const result = await this.request('session/new', { cwd, mcpServers: [] });
    if (typeof result.sessionId !== 'string' || !result.sessionId)
      throw new Failure('protocol');
    this.sessionId = result.sessionId;
    await this.onSession?.(this.sessionId);
    return result;
  }
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
    const text = this.output
      .join('')
      .split('\n')
      .filter(
        (l) =>
          !(l.trim().startsWith('Warning:') && /skill/i.test(l)) &&
          !l.trim().startsWith('⚠'),
      )
      .join('\n')
      .trim();
    // ACP can report account exhaustion as a successful plain-text end_turn.
    // Match the provider notice at the start; spoken quota terms in a timed
    // transcript must remain ordinary transcript content.
    if (
      /^Usage Limit Reached\s+You have reached your current quota for this period\./i.test(
        text,
      )
    )
      throw new Failure('quota_exhausted');
    return text;
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
    if (
      !/authenticate|__YUTORAH_AUTH_URL__|__LECTERN_ANTIGRAVITY_AUTH_URL__/.test(
        line,
      )
    )
      return false;
    this.fail(new Failure('auth_required'));
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
            error.code === 429 ||
              /quota.*(?:exceeded|exhausted)|resource.?exhausted|rate.?limit/i.test(
                String(error.message),
              )
              ? 'quota_exhausted'
              : error.code === 401 ||
                  /auth|sign.?in/i.test(String(error.message))
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
                message:
                  'Notes generation does not support tools or user input',
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
      const content = object(update.content);
      if (content.type === 'text' && typeof content.text === 'string')
        this.diagnostics.thoughtBytes += Buffer.byteLength(content.text);
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
