import { readFile, readdir, readlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
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
    env?: NodeJS.ProcessEnv;
  },
): Promise<Buffer> {
  checkAbort(options.signal);
  const owned = new OwnedProcess(
    executable,
    args,
    options.cwd,
    options.env ?? {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
    },
  );
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

/** Reap an orphaned owned group even when its original parent has already exited. */
export async function terminateOwnedWorkspace(
  root: string,
  ledgerName: string,
) {
  const owner = await readFile(join(root, ledgerName), 'utf8')
    .then(JSON.parse)
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  const processes = [];
  for (const name of (await readdir('/proc')).filter((n) => /^\d+$/.test(n))) {
    const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => null);
    if (!stat) continue;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const cwd = await readlink(`/proc/${name}/cwd`).catch(() => null);
    processes.push({
      pid: Number(name),
      group: Number(fields[2]),
      startTicks: fields[19],
      state: fields[0],
      cwd,
    });
  }
  const original = owner ? processes.find((p) => p.pid === owner.pid) : null;
  if (original && original.startTicks !== owner.startTicks) return; // PID reuse: never signal its new owner.
  const ownedCwd = (cwd: string | null) =>
    cwd === root || !!cwd?.startsWith(root + sep);
  const groups = owner
    ? [Number(owner.pid)]
    : [
        ...new Set(
          processes.filter((p) => ownedCwd(p.cwd)).map((p) => p.group),
        ),
      ];
  for (const group of groups) {
    const members = processes.filter(
      (p) => p.group === group && p.state !== 'Z',
    );
    if (!members.length) continue;
    if (
      members.some((p) => !ownedCwd(p.cwd)) ||
      members.some((p) => p.pid === process.pid)
    )
      throw new Failure('configuration');
    try {
      process.kill(-group, 'SIGTERM');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
    await delay(2000);
    try {
      process.kill(-group, 'SIGKILL');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
    let stopped = false;
    for (let check = 0; check < 30; check++) {
      let alive = false;
      for (const member of members) {
        const stat = await readFile(`/proc/${member.pid}/stat`, 'utf8').catch(
          () => null,
        );
        if (stat) {
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          alive ||= fields[19] === member.startTicks && fields[0] !== 'Z';
        }
      }
      if (!alive) {
        stopped = true;
        break;
      }
      await delay(100);
    }
    if (!stopped) throw new Failure('configuration');
  }
}
