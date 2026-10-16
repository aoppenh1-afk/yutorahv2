import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { PipelineFailure } from '../../notes-only/src/control.js';
import type { RuntimeMessage } from './evidence.js';
import type { ServerAPI } from './server.js';

export type EventStream = (
  signal: AbortSignal,
) => Promise<ReadableStream<Uint8Array>>;
type Watcher = {
  fail: (error: unknown, reason?: 'resume_stall') => void;
  output: () => void;
  complete?: (messages: RuntimeMessage[]) => void;
  discontinuity?: (clock: {
    wallGapMs: number;
    elapsedGapMs: number;
    adjustmentMs: number;
  }) => void;
};
type RuntimeEvent = {
  type?: string;
  properties?: {
    sessionID?: string;
    id?: string;
    field?: string;
    delta?: string;
    messageID?: string;
    info?: { id?: string; role?: string; sessionID?: string };
    part?: {
      id?: string;
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
  private progress = new Map<
    string,
    {
      at: number;
      sizes: Map<string, number>;
      historyBytes: number;
      failed: boolean;
      completed: boolean;
      lastTick: number;
      lastWallTick: number;
      resumeUntil: number;
      recoveryAt?: number;
      recoveryBaselined: boolean;
      recoveryBaselining: boolean;
      controller: AbortController;
      checking?: Promise<void>;
      timer: ReturnType<typeof setInterval>;
    }
  >();
  private connections = 0;
  private permissionReads = 0;
  private historyReads = 0;
  private silenceChecks = 0;
  private rescuedProgress = 0;
  private completedHistories = 0;
  private resumeGraces = 0;
  private discontinuities = 0;
  private resumeRecoveries = 0;
  status() {
    return {
      connected: this.connected,
      ownedSessions: this.watchers.size,
      connections: this.connections,
      permissionReads: this.permissionReads,
      historyReads: this.historyReads,
      silenceChecks: this.silenceChecks,
      rescuedProgress: this.rescuedProgress,
      completedHistories: this.completedHistories,
      resumeGraces: this.resumeGraces,
      discontinuities: this.discontinuities,
      resumeRecoveries: this.resumeRecoveries,
    };
  }
  constructor(
    readonly api: ServerAPI,
    readonly stream?: EventStream,
    readonly settings: {
      pollMs: number;
      reconcileMs: number;
      retryMs: number;
      idleMs: number;
      stallMs?: number;
      recheckMs?: number;
      resumeGraceMs?: number;
      resumeStallMs?: number;
    } = {
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
    const stallMs = this.settings.stallMs ?? 180_000;
    const progress = {
      at: performance.now(),
      sizes: new Map<string, number>(),
      historyBytes: 0,
      failed: false,
      completed: false,
      lastTick: performance.now(),
      lastWallTick: Date.now(),
      resumeUntil: 0,
      recoveryAt: undefined as number | undefined,
      recoveryBaselined: false,
      recoveryBaselining: false,
      controller: new AbortController(),
      timer: setInterval(
        () => this.checkSilence(id, watcher),
        Math.min(1000, Math.max(1, stallMs / 4)),
      ),
    };
    this.progress.set(id, progress);
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
      clearInterval(progress.timer);
      progress.controller.abort();
      await this.progress.get(id)?.checking;
      this.progress.delete(id);
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

  private checkSilence(id: string, watcher: Watcher) {
    const progress = this.progress.get(id);
    const stallMs = this.settings.stallMs ?? 180_000;
    const now = performance.now();
    if (progress) {
      const gap = now - progress.lastTick;
      const wall = Date.now();
      const wallGapMs = wall - progress.lastWallTick;
      const adjustmentMs = wallGapMs - gap;
      progress.lastTick = now;
      progress.lastWallTick = wall;
      // A wall-clock correction alone is not a host pause. Require a delayed
      // execution tick as corroboration, or a genuinely prolonged process pause.
      if (gap >= 30000 || (gap >= 4000 && adjustmentMs >= 30000)) {
        progress.recoveryAt = now;
        progress.recoveryBaselined = false;
        progress.resumeUntil = now + (this.settings.resumeGraceMs ?? 5000);
        this.discontinuities++;
        this.nextPoll = 0;
        watcher.discontinuity?.({ wallGapMs, elapsedGapMs: gap, adjustmentMs });
      }
      if (gap > Math.max(1000, Math.min(1000, stallMs / 4) * 4)) {
        progress.resumeUntil = now + (this.settings.resumeGraceMs ?? 5000);
        this.resumeGraces++;
        this.nextPoll = 0;
      }
    }
    const deadline = () =>
      Math.min(
        (progress?.at ?? now) + stallMs,
        progress?.recoveryAt === undefined
          ? Infinity
          : Math.max(progress.at, progress.recoveryAt) +
              (this.settings.resumeStallMs ?? 60000),
      );
    const baseline =
      progress?.recoveryAt !== undefined && !progress.recoveryBaselined;
    if (
      !progress ||
      progress.failed ||
      progress.completed ||
      progress.checking ||
      now < progress.resumeUntil ||
      (!baseline && now < deadline())
    )
      return;
    const observedAt = progress.at;
    if (baseline) {
      progress.recoveryBaselined = true;
      progress.recoveryBaselining = true;
    } else this.silenceChecks++;
    // Timers can run before queued stream events after a process pause. Read
    // persisted progress before cancellation, with a separate bounded deadline.
    progress.checking = (async () => {
      try {
        await this.reconcile(
          id,
          watcher,
          AbortSignal.any([
            progress.controller.signal,
            AbortSignal.timeout(this.settings.recheckMs ?? 5000),
          ]),
        );
        // Establish the persisted post-grace baseline before deciding whether
        // later history is new output. Queued catch-up is not a healthy stream.
        if (baseline) return;
        if (
          this.progress.get(id) !== progress ||
          progress.failed ||
          progress.completed ||
          performance.now() < progress.resumeUntil
        )
          return;
        if (progress.at > observedAt) this.rescuedProgress++;
        else if (performance.now() >= deadline()) {
          progress.failed = true;
          const resumed = progress.recoveryAt !== undefined;
          if (resumed) this.resumeRecoveries++;
          watcher.fail(
            new PipelineFailure('timeout'),
            resumed ? 'resume_stall' : undefined,
          );
        }
      } catch (error) {
        if (
          !baseline &&
          !progress.controller.signal.aborted &&
          this.progress.get(id) === progress
        ) {
          progress.failed = true;
          watcher.fail(error);
        }
      }
    })().finally(() => {
      if (baseline) progress.recoveryBaselining = false;
      progress.checking = undefined;
    });
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

  private output(id: string, key: string, bytes: number, delta = false) {
    const progress = this.progress.get(id);
    if (!progress || progress.failed || bytes <= 0) return;
    if (!delta && bytes <= (progress.sizes.get(key) ?? 0)) return;
    if (!delta) progress.sizes.set(key, bytes);
    progress.at = performance.now();
    // Give queued events their catch-up grace; output arriving during that
    // grace cannot by itself prove the upstream connection resumed producing.
    if (!progress.recoveryBaselining && progress.at >= progress.resumeUntil)
      progress.recoveryAt = undefined;
    this.watchers.get(id)?.output();
  }

  private async reconcile(id: string, watcher: Watcher, signal: AbortSignal) {
    this.historyReads++;
    const messages = (await this.api(
      `/session/${id}/message`,
      'GET',
      undefined,
      signal,
    )) as RuntimeMessage[];
    if (signal.aborted || this.watchers.get(id) !== watcher) return;
    if (
      messages.some((m) =>
        m.parts?.some((p) => ['tool', 'subtask', 'agent'].includes(p.type)),
      )
    )
      throw new PipelineFailure('off_task');
    const assistants = messages.filter((m) => m.info?.role === 'assistant');
    for (const m of assistants)
      if (m.info.id) this.assistants.get(id)?.add(m.info.id);
    const bytes = assistants.reduce(
      (sum, m) =>
        sum +
        (m.parts ?? []).reduce(
          (n, p) =>
            n +
            (['text', 'reasoning'].includes(p.type)
              ? (p.text?.length ?? 0)
              : 0),
          0,
        ),
      0,
    );
    const progress = this.progress.get(id);
    // Repeated snapshots are not progress and cannot extend a silent request.
    if (progress && bytes > progress.historyBytes) {
      progress.historyBytes = bytes;
      this.output(id, 'history', bytes);
    }
    const last = assistants.at(-1)?.info;
    if (
      progress &&
      !progress.failed &&
      !progress.completed &&
      watcher.complete &&
      last?.time?.completed &&
      last.finish
    ) {
      progress.completed = true;
      this.completedHistories++;
      // The adapter independently validates identity, cost, completion and tools.
      watcher.complete(messages);
    }
  }

  private event(event: RuntimeEvent) {
    const p = event.properties;
    const id = p?.sessionID ?? p?.part?.sessionID ?? p?.info?.sessionID;
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
        this.output(
          id!,
          p.part.id ?? `${p.part.messageID}:${p.part.type}`,
          p.part.text.length,
        );
    }
    if (event.type === 'message.part.delta' && assistant && p?.delta)
      this.output(id!, '', p.delta.length, true);
  }

  private async poll(signal: AbortSignal) {
    while (!signal.aborted) {
      if (performance.now() >= this.nextPoll) {
        this.nextPoll =
          performance.now() +
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
            await this.reconcile(id, w, signal);
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
