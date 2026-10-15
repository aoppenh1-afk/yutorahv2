import { setTimeout as delay } from 'node:timers/promises';
import { PipelineFailure } from '../../notes-only/src/control.js';
import type { RuntimeMessage } from './evidence.js';
import type { ServerAPI } from './server.js';

export type EventStream = (
  signal: AbortSignal,
) => Promise<ReadableStream<Uint8Array>>;
type Watcher = { fail: (error: unknown) => void; output: () => void };
type RuntimeEvent = {
  type?: string;
  properties?: {
    sessionID?: string;
    id?: string;
    field?: string;
    delta?: string;
    messageID?: string;
    info?: { id?: string; role?: string };
    part?: {
      type?: string;
      text?: string;
      sessionID?: string;
      messageID?: string;
    };
  };
};

/** One SSE subscription per owned server. Full histories are read only for reconciliation and final evidence. */
export class SharedSessionMonitor {
  private watchers = new Map<string, Watcher>();
  private controller?: AbortController;
  private tasks: Promise<unknown>[] = [];
  private ready: Promise<void> = Promise.resolve();
  private stopping?: Promise<void>;
  private connected = false;
  private nextPoll = 0;
  private assistants = new Map<string, Set<string>>();
  private connections = 0;
  private permissionReads = 0;
  private historyReads = 0;
  status() {
    return {
      connected: this.connected,
      ownedSessions: this.watchers.size,
      connections: this.connections,
      permissionReads: this.permissionReads,
      historyReads: this.historyReads,
    };
  }
  constructor(
    readonly api: ServerAPI,
    readonly stream?: EventStream,
    readonly settings = {
      pollMs: 2000,
      reconcileMs: 30000,
      retryMs: 1000,
      idleMs: 45000,
    },
  ) {}

  async watch(id: string, watcher: Watcher): Promise<() => Promise<void>> {
    await this.stopping;
    this.watchers.set(id, watcher);
    this.assistants.set(id, new Set());
    if (!this.controller) {
      const controller = (this.controller = new AbortController());
      // Register the event listener before sending the first prompt.
      this.ready = this.stream
        ? this.connect(controller.signal)
        : Promise.resolve();
      this.tasks.push(this.ready, this.poll(controller.signal));
    }
    await this.ready;
    return async () => {
      this.watchers.delete(id);
      this.assistants.delete(id);
      if (!this.watchers.size && this.controller) {
        this.controller.abort();
        this.stopping = Promise.allSettled(this.tasks).then(() => {
          this.controller = undefined;
          this.connected = false;
          this.tasks = [];
          this.stopping = undefined;
        });
        await this.stopping;
      }
    };
  }

  private async connect(signal: AbortSignal) {
    // The first connection attempt gates request dispatch; later reconnects run in the background.
    let opened: ReadableStream<Uint8Array> | undefined;
    try {
      opened = await this.stream!(signal);
    } catch {
      this.nextPoll = 0;
    }
    const pump = this.pump(signal, opened);
    this.tasks.push(pump);
  }
  private async pump(signal: AbortSignal, opened?: ReadableStream<Uint8Array>) {
    while (!signal.aborted) {
      try {
        const body = opened ?? (await this.stream!(signal));
        opened = undefined;
        this.connected = true;
        this.connections++;
        // Reconnect is not replay: inspect all owned sessions for events missed in the gap.
        this.nextPoll = 0;
        await readEvents(
          body,
          signal,
          (event) => this.event(event),
          this.settings.idleMs,
        );
      } catch {
        // Polling remains authoritative during disconnect; a failed reconciliation cancels affected requests.
      } finally {
        this.connected = false;
        this.nextPoll = 0;
      }
      await delay(this.settings.retryMs, undefined, { signal }).catch(() => {});
    }
  }

  private event(event: RuntimeEvent) {
    const p = event.properties;
    const id = p?.sessionID ?? p?.part?.sessionID;
    const watcher = id ? this.watchers.get(id) : undefined;
    if (!watcher) return;
    if (
      event.type === 'message.updated' &&
      p?.info?.role === 'assistant' &&
      p.info.id
    )
      this.assistants.get(id!)?.add(p.info.id);
    const assistant = this.assistants
      .get(id!)
      ?.has(p?.messageID ?? p?.part?.messageID ?? '');
    if (event.type === 'permission.asked' && p?.id) {
      watcher.fail(new PipelineFailure('off_task'));
      // Permission requests are rejected, including when the request abort races with the reply.
      const reply = this.api(`/permission/${p.id}/reply`, 'POST', {
        reply: 'reject',
      }).catch((error) => watcher.fail(error));
      this.tasks.push(reply);
      void reply.finally(() => {
        const i = this.tasks.indexOf(reply);
        if (i >= 0) void this.tasks.splice(i, 1);
      });
    }
    if (event.type === 'message.part.updated' && p?.part) {
      if (['tool', 'subtask', 'agent'].includes(p.part.type ?? ''))
        watcher.fail(new PipelineFailure('off_task'));
      if (
        assistant &&
        ['text', 'reasoning'].includes(p.part.type ?? '') &&
        p.part.text
      )
        watcher.output();
    }
    if (event.type === 'message.part.delta' && assistant && p?.delta)
      watcher.output();
  }

  private async poll(signal: AbortSignal) {
    while (!signal.aborted) {
      if (Date.now() >= this.nextPoll) {
        this.nextPoll =
          Date.now() +
          (this.connected ? this.settings.reconcileMs : this.settings.pollMs);
        const watchers = [...this.watchers];
        try {
          this.permissionReads++;
          const permissions = (await this.api(
            '/permission',
            'GET',
            undefined,
            signal,
          )) as Array<{ id: string; sessionID: string }>;
          for (const permission of permissions) {
            const watcher = this.watchers.get(permission.sessionID);
            if (watcher) {
              watcher.fail(new PipelineFailure('off_task'));
              await this.api(
                `/permission/${permission.id}/reply`,
                'POST',
                { reply: 'reject' },
                signal,
              );
            }
          }
        } catch (error) {
          if (!signal.aborted)
            for (const [id, w] of watchers)
              if (this.watchers.get(id) === w) w.fail(error);
        }
        // Serial, bounded reads avoid a burst of full histories on reconnect.
        for (const [id, w] of watchers) {
          if (signal.aborted || this.watchers.get(id) !== w) continue;
          try {
            this.historyReads++;
            const messages = (await this.api(
              `/session/${id}/message`,
              'GET',
              undefined,
              signal,
            )) as RuntimeMessage[];
            for (const m of messages)
              if (m.info?.role === 'assistant' && m.info.id)
                this.assistants.get(id)?.add(m.info.id);
            if (
              messages.some((m) =>
                m.parts?.some((p) =>
                  ['tool', 'subtask', 'agent'].includes(p.type),
                ),
              )
            )
              w.fail(new PipelineFailure('off_task'));
          } catch (error) {
            if (!signal.aborted && this.watchers.get(id) === w) w.fail(error);
          }
        }
      }
      await delay(Math.min(250, this.settings.pollMs), undefined, {
        signal,
      }).catch(() => {});
    }
  }
}

/** Bounded UTF-8 SSE parsing, including split chunks, CRLF, and multiline data. Never stores conversation history. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  receive: (event: RuntimeEvent) => void,
  idleMs: number,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const timer = setTimeout(abort, idleMs);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024)
        throw new Error('Oversized runtime event.');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        const envelope = JSON.parse(data);
        receive(envelope.payload ?? envelope);
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
