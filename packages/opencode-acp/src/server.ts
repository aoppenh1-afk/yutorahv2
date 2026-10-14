import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  OwnedProcess,
  runProcess,
  terminateOwnedWorkspace,
} from './process.js';
import { notesAgentConfig, OPENCODE_VERSION } from './runtime.js';
import {
  MODEL_ID,
  assertFreeCatalog,
  messageEvidence,
  type RuntimeMessage,
  type Catalog,
} from './evidence.js';
import { PipelineFailure, classify } from '../../notes-only/src/control.js';
import { durableWrite } from '../../notes-only/src/artifacts.js';
import { streamBytes } from '../../../lib/tidb-notes-store.js';
import type { NotesQueue, NoteJob } from '../../notes-only/src/queue.js';

export type ServerAPI = (
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
/** The adapter uses the pinned runtime's observed schema; it fails closed on drift. */
type SchemaNode = { type?: string; properties?: Record<string, SchemaNode> };
type SchemaDoc = {
  paths?: Record<
    string,
    Record<
      string,
      { requestBody?: { content?: Record<string, { schema?: SchemaNode }> } }
    >
  >;
};
type Session = { id: string; title: string };
type Statuses = Record<string, { type: string }>;
type Permission = { id: string; sessionID: string };
type EffectiveConfig = {
  model: string;
  small_model: string;
  default_agent: string;
  agent?: { plan?: { model: string; variant: string } };
  autoupdate: boolean;
  share: string;
  permission?: Record<string, string>;
};
export function verifySchema(doc: SchemaDoc) {
  const paths = doc.paths;
  const props =
    paths?.['/session/{sessionID}/message']?.post?.requestBody?.content?.[
      'application/json'
    ]?.schema?.properties;
  if (
    !props ||
    props.variant?.type !== 'string' ||
    props.agent?.type !== 'string' ||
    !props.model?.properties?.providerID ||
    !props.model?.properties?.modelID ||
    !props.parts
  )
    throw new PipelineFailure('configuration', 'muse', 0, true);
  for (const [path, method] of [
    ['/session', 'post'],
    ['/session/status', 'get'],
    ['/session/{sessionID}', 'delete'],
    ['/session/{sessionID}/abort', 'post'],
    ['/permission', 'get'],
    ['/permission/{requestID}/reply', 'post'],
  ])
    if (!paths?.[path]?.[method])
      throw new PipelineFailure('configuration', 'muse', 0, true);
}
export class ServerSessionAdapter {
  constructor(
    readonly api: ServerAPI,
    readonly queue: NotesQueue,
    readonly owner: string,
    readonly deadlineMs: number,
  ) {}
  async reconcile() {
    // Recover the create-session / ledger crash gap by the worker-specific title prefix.
    const sessions = (await this.api('/session')) as Session[];
    for (const session of sessions) {
      if (
        typeof session.title !== 'string' ||
        !session.title.startsWith(this.owner + ':')
      )
        continue;
      const fields = session.title.slice(this.owner.length + 1).split(':');
      if (fields.length !== 3 || !/^\d+$/.test(fields[0]))
        throw new PipelineFailure('session_uncertain', 'muse', 0, true);
      this.queue.db
        .prepare("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,'uncertain',?)")
        .run(session.id, fields[0], fields[1], 'server', Date.now());
    }
    for (const row of this.queue.db
      .prepare(
        "SELECT id FROM sessions WHERE runtime='server' AND state!='deleted'",
      )
      .all())
      await this.cancelAndDelete(String(row.id));
  }
  async cancelAndDelete(id: string) {
    if (
      this.queue.db
        .prepare("SELECT 1 FROM sessions WHERE id=? AND state='deleted'")
        .get(id)
    )
      return;
    if (!/^ses[A-Za-z0-9_-]+$/.test(id))
      throw new PipelineFailure('session_uncertain', 'muse', 0, true);
    try {
      await this.api(`/session/${id}/abort`, 'POST');
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      let missing = false;
      try {
        await this.api(`/session/${id}`);
      } catch (readError) {
        missing = (readError as { status?: number }).status === 404;
      }
      if (!missing)
        throw new PipelineFailure('session_uncertain', 'muse', 0, true);
      this.queue.db
        .prepare("UPDATE sessions SET state='deleted' WHERE id=?")
        .run(id);
      return;
    }
    let idle = false;
    for (let i = 0; i < 30; i++) {
      const statuses = (await this.api('/session/status')) as Statuses;
      if (!statuses[id] || statuses[id].type === 'idle') {
        idle = true;
        break;
      }
      await delay(100);
    }
    if (!idle) throw new PipelineFailure('session_uncertain', 'muse', 0, true);
    let removed: unknown;
    try {
      removed = await this.api(`/session/${id}`, 'DELETE');
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      let missing = false;
      try {
        await this.api(`/session/${id}`);
      } catch (readError) {
        missing = (readError as { status?: number }).status === 404;
      }
      if (!missing)
        throw new PipelineFailure('session_uncertain', 'muse', 0, true);
      removed = true;
    }
    if (removed !== true)
      throw new PipelineFailure('session_uncertain', 'muse', 0, true);
    this.queue.db
      .prepare("UPDATE sessions SET state='deleted' WHERE id=?")
      .run(id);
  }
  async request(
    job: NoteJob,
    requestID: string,
    prompt: string,
    signal: AbortSignal,
    capture?: (messages: RuntimeMessage[]) => Promise<void>,
  ) {
    signal.throwIfAborted();
    const title = `${this.owner}:${job.id}:${job.lease_token}:${requestID}`;
    // Once creation is sent, always learn its ID before honoring cancellation.
    const session = (await this.api('/session', 'POST', { title })) as Session;
    if (
      !/^ses[A-Za-z0-9_-]+$/.test(session.id ?? '') ||
      session.title !== title
    )
      throw new PipelineFailure('session_uncertain', 'muse', 0, true);
    const id = session.id;
    this.queue.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,'active',?)")
      .run(id, job.id, job.lease_token, 'server', Date.now());
    const requestAbort = new AbortController();
    const requestSignal = AbortSignal.any([
      signal,
      requestAbort.signal,
      AbortSignal.timeout(this.deadlineMs),
    ]);
    let done = false;
    let monitorError: unknown;
    const monitor = (async () => {
      while (!done && !requestSignal.aborted) {
        try {
          const permissions = (await this.api('/permission')) as Permission[];
          for (const permission of permissions)
            if (permission.sessionID === id) {
              await this.api(`/permission/${permission.id}/reply`, 'POST', {
                reply: 'reject',
              });
              throw new PipelineFailure('off_task');
            }
          const messages = (await this.api(
            `/session/${id}/message`,
          )) as RuntimeMessage[];
          if (
            messages.some((m) =>
              m.parts?.some((p) =>
                ['tool', 'subtask', 'agent'].includes(p.type),
              ),
            )
          )
            throw new PipelineFailure('off_task');
        } catch (error) {
          monitorError = error;
          requestAbort.abort();
          return;
        }
        await delay(500, undefined, { signal: requestSignal }).catch(() => {});
      }
    })();
    let result:
      | {
          value: string;
          evidence: ReturnType<typeof messageEvidence>;
          messages: RuntimeMessage[];
        }
      | undefined;
    let requestError: unknown;
    try {
      const response = (await this.api(
        `/session/${id}/message`,
        'POST',
        {
          model: { providerID: 'opencode', modelID: MODEL_ID },
          agent: 'plan',
          variant: 'high',
          parts: [{ type: 'text', text: prompt }],
        },
        requestSignal,
      )) as RuntimeMessage;
      if (monitorError) throw monitorError;
      const messages = (await this.api(
        `/session/${id}/message`,
      )) as RuntimeMessage[];
      await capture?.(messages);
      const evidence = messageEvidence(messages, id);
      const text = (response.parts ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (!text) throw new PipelineFailure('incomplete_output');
      result = { value: text, evidence, messages };
    } catch (error) {
      requestError =
        monitorError ??
        (requestSignal.aborted
          ? new PipelineFailure(signal.aborted ? 'cancelled' : 'timeout')
          : error);
      if (capture)
        await this.api(`/session/${id}/message`)
          .then((value) => capture(value as RuntimeMessage[]))
          .catch(() => {});
    }
    done = true;
    requestAbort.abort();
    await monitor;
    try {
      await this.cancelAndDelete(id);
    } catch {
      requestError = new PipelineFailure('session_uncertain', 'muse', 0, true);
    }
    if (requestError) throw requestError;
    return result!;
  }
}

/** Owns exactly one authenticated loopback server and its process group. Never attaches to a user's server. */
export class OpenCodeServer {
  private process?: OwnedProcess;
  private base = '';
  private password = '';
  private starting?: Promise<void>;
  private checkedAt = 0;
  readonly owner: string;
  readonly adapter: ServerSessionAdapter;
  readonly api: ServerAPI;
  constructor(
    readonly config: {
      executable: string;
      root: string;
      deadlineMs: number;
      catalogTtlMs: number;
    },
    readonly queue: NotesQueue,
  ) {
    this.owner =
      'yutorah-notes-' +
      createHash('sha256').update(config.root).digest('hex').slice(0, 16);
    this.api = async (path, method = 'GET', body, signal) => {
      if (!this.base)
        throw new PipelineFailure('session_uncertain', 'muse', 0, true);
      let response: Response;
      try {
        response = await fetch(this.base + path, {
          method,
          redirect: 'error',
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from('opencode:' + this.password).toString('base64'),
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([
            signal ?? new AbortController().signal,
            AbortSignal.timeout(
              method === 'POST' && path.endsWith('/message')
                ? config.deadlineMs
                : 30_000,
            ),
          ]),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new PipelineFailure('server_unavailable');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`OpenCode HTTP ${response.status}`), {
          status: response.status,
          retryAfter: response.headers.get('Retry-After'),
        });
      }
      const text = response.body
        ? new TextDecoder('utf-8', { fatal: true }).decode(
            await streamBytes(response.body, 16 * 1024 * 1024),
          )
        : '';
      return text ? JSON.parse(text) : null;
    };
    this.adapter = new ServerSessionAdapter(
      this.api,
      queue,
      this.owner,
      config.deadlineMs,
    );
  }
  private async oldProcess() {
    const path = join(this.config.root, 'owner.json');
    await terminateOwnedWorkspace(this.config.root, 'owner.json');
    // Bun leaves embedded native libraries on disk. Reap them only after
    // the previous owned process group has been confirmed stopped.
    await rm(join(this.config.root, 'tmp'), { recursive: true, force: true });
    await rm(path, { force: true });
  }
  async start() {
    if (
      this.process &&
      this.process.child.exitCode === null &&
      this.process.child.signalCode === null &&
      this.base
    )
      return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.boot();
          return;
        } catch (error) {
          if (classify(error, 'muse').pause || attempt === 2) throw error;
          await delay(500 * 2 ** attempt);
        }
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async boot() {
    const { root, executable } = this.config;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await this.oldProcess();
    const temp = join(root, 'tmp');
    await mkdir(temp, { mode: 0o700 });
    let owned: OwnedProcess | undefined;
    try {
      const signal = AbortSignal.timeout(30_000);
      const version = (
        await runProcess(executable, ['--version'], {
          cwd: root,
          signal,
          maxBytes: 1024,
          env: {
            PATH: process.env.PATH,
            LANG: 'C.UTF-8',
            NODE_ENV: 'production',
            TMPDIR: temp,
            BUN_TMPDIR: temp,
          },
        })
      )
        .toString()
        .trim();
      if (version !== OPENCODE_VERSION)
        throw new PipelineFailure('configuration', 'muse', 0, true);
      await runProcess('git', ['init', '--quiet', '--template=', root], {
        cwd: root,
        signal,
        maxBytes: 4096,
      });
      const config = notesAgentConfig();
      await writeFile(join(root, 'opencode.json'), JSON.stringify(config), {
        mode: 0o600,
      });
      this.password = randomBytes(32).toString('hex');
      this.base = '';
      this.checkedAt = 0;
      owned = new OwnedProcess(
        executable,
        ['serve', '--hostname', '127.0.0.1', '--port', '0'],
        root,
        {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: temp,
          BUN_TMPDIR: temp,
          LANG: 'C.UTF-8',
          NODE_ENV: 'production',
          XDG_CONFIG_HOME: join(root, 'config'),
          OPENCODE_CONFIG: join(root, 'opencode.json'),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_SERVER_PASSWORD: this.password,
        },
      );
      this.process = owned;
      let output = '';
      owned.child.stdout.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) this.base = match[0];
      });
      owned.child.stderr.resume();
      const pid = owned.child.pid;
      if (!pid) throw new PipelineFailure('server_unavailable');
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      await durableWrite(
        join(root, 'owner.json'),
        JSON.stringify({
          pid,
          startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
        }),
      );
      for (let i = 0; i < 150 && !this.base; i++) {
        if (owned.child.exitCode !== null)
          throw new PipelineFailure('server_unavailable');
        await delay(100);
      }
      if (!this.base) throw new PipelineFailure('server_unavailable');
      await this.verify();
      await this.adapter.reconcile();
    } catch (error) {
      await owned?.stop();
      await rm(temp, { recursive: true, force: true });
      this.base = '';
      throw error;
    }
  }
  async verify() {
    const health = (await this.api('/global/health')) as {
      healthy: boolean;
      version: string;
    };
    if (health.healthy !== true || health.version !== OPENCODE_VERSION)
      throw new PipelineFailure('configuration', 'muse', 0, true);
    const schema = (await this.api('/doc')) as SchemaDoc;
    verifySchema(schema);
    const config = (await this.api('/config')) as EffectiveConfig;
    const plan = config.agent?.plan;
    if (
      config.model !== `opencode/${MODEL_ID}` ||
      config.small_model !== config.model ||
      config.default_agent !== 'plan' ||
      plan?.model !== config.model ||
      plan?.variant !== 'high' ||
      config.autoupdate !== false ||
      config.share !== 'disabled' ||
      config.permission?.['*'] !== 'ask'
    )
      throw new PipelineFailure('configuration', 'muse', 0, true);
    assertFreeCatalog((await this.api('/config/providers')) as Catalog);
    await durableWrite(
      join(this.config.root, 'schema.json'),
      JSON.stringify(schema),
    );
    await durableWrite(
      join(this.config.root, 'verification.json'),
      JSON.stringify({
        at: Date.now(),
        version: OPENCODE_VERSION,
        model: config.model,
        smallModel: config.small_model,
        agent: 'plan',
        effort: 'high',
        prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        schemaHash: createHash('sha256')
          .update(JSON.stringify(schema))
          .digest('hex'),
      }),
    );
    this.checkedAt = Date.now();
  }
  async guard() {
    await this.start();
    if (Date.now() - this.checkedAt >= this.config.catalogTtlMs)
      await this.verify();
  }
  async request(
    job: NoteJob,
    id: string,
    prompt: string,
    signal: AbortSignal,
    capture?: (messages: RuntimeMessage[]) => Promise<void>,
  ) {
    await this.guard();
    return this.adapter.request(job, id, prompt, signal, capture);
  }
  async close() {
    await this.process?.stop();
    this.process = undefined;
    this.base = '';
    await rm(join(this.config.root, 'tmp'), { recursive: true, force: true });
    await rm(join(this.config.root, 'owner.json'), { force: true });
  }
}
