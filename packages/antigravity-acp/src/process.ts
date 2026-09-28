import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { abortReason, checkAbort, Failure } from './errors.js';

export class OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private stopping?: Promise<void>;
  constructor(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: 'pipe',
    });
    this.exited = new Promise((resolve) => {
      this.child.once('close', () => resolve());
      this.child.once('error', () => resolve());
    });
  }
  stop(graceMs = 2000): Promise<void> {
    return (this.stopping ??= (async () => {
      const pid = this.child.pid;
      const signal = (s: NodeJS.Signals) => {
        if (pid) {
          try {
            process.kill(-pid, s);
          } catch {
            /* Already gone. */
          }
        }
      };
      this.child.stdin.destroy();
      signal('SIGTERM');
      // Do not stop escalation when the parent exits: its children may ignore TERM.
      await delay(graceMs);
      signal('SIGKILL');
      await this.exited;
    })());
  }
}

/** Bounded output, no shell, and cancellation/timeout terminate the whole owned group. */
export async function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    signal: AbortSignal;
    maxBytes?: number;
    timeoutMs?: number;
  },
): Promise<Buffer> {
  checkAbort(options.signal);
  const owned = new OwnedProcess(executable, args, options.cwd, {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
  });
  const child = owned.child;
  const chunks: Buffer[] = [];
  let bytes = 0;
  let error: Failure | undefined;
  const stop = (e: Failure) => {
    error ??= e;
    void owned.stop();
  };
  const abort = () => stop(abortReason(options.signal));
  options.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => stop(new Failure('timeout')),
    options.timeoutMs ?? 300_000,
  );
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (options.maxBytes ?? 1024 * 1024))
      stop(new Failure('output_limit'));
    else chunks.push(chunk);
  });
  child.stderr.resume(); // Never persist commands, paths, or raw process output.
  child.once('error', () => {
    error ??= new Failure('process_exit');
  });
  child.stdin.end();
  try {
    await owned.exited;
    if (error) throw error;
    if (child.exitCode !== 0) throw new Failure('invalid_audio');
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    await owned.stop(error ? 2000 : 0);
  }
}
