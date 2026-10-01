#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const help = `Usage: yutorah-queue COMMAND [arguments]

  status                         Queue totals, settings, and worker state
  jobs                           Latest 100 jobs, including notes job IDs
  targets                        Saved teacher/series selections and budgets
  directory [SEARCH]             Find teacher and series IDs by name
  add-teacher ID --limit TOTAL    Save/enable a teacher selection
  add-series ID --limit TOTAL [--teacher ID]
                                 Save/enable a series, optionally one teacher
  enable TARGET_UUID             Enable a saved selection
  disable TARGET_UUID            Pause discovery and future claims for a selection
  budget TARGET_UUID TOTAL       Change its total recording budget
  scan [PAGES]                   Import enabled selections (default 2 pages each)
  start                          Start the queue
  pause                          Pause the queue, preserving checkpoints
  retry JOB_UUID [--notes]        Retry a failed/cancelled job
  cancel JOB_UUID [--notes]       Cancel a job
  content SHIUR_ID                Read a completed transcript and notes
  model MODEL_ID                 Save an advertised model (restarts active queue)
  notes on|off                    Set automatic notes (restarts active queue)

All results are JSON; failures exit nonzero. Budgets are total caps, not extra
jobs per scan. Saving a selection does not explicitly import or start work;
an already running worker discovers enabled selections automatically.
This command uses the VM-local operator on 127.0.0.1:8766. No sudo or secrets
are needed. YUTORAH_OPERATOR_PORT overrides the port for another local instance.
`;

export async function control(args, { request } = {}) {
  const [command, ...rest] = args;
  if (!command || ['help', '--help', '-h'].includes(command)) return help;
  const port = Number(process.env.YUTORAH_OPERATOR_PORT ?? 8766);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('YUTORAH_OPERATOR_PORT must be a port from 1024 to 65535.');
  request ??= async (path, data) => {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/operator/${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers:
          data === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'X-Operator-Request': '1',
              },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(150_000),
        redirect: 'error',
      });
    } catch {
      throw new Error(
        `Cannot reach the local operator on port ${port}. Check that yutorah-operator is running.`,
      );
    }
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        `Operator HTTP ${response.status}: ${result.error ?? 'Request failed.'}`,
      );
    return result;
  };
  const usage = () => {
    throw new Error(
      `Invalid arguments for ${command}. Run yutorah-queue help.`,
    );
  };
  const id = (value) => (/^\d{1,12}$/.test(value ?? '') ? value : usage());
  const uuid = (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value ?? '',
    )
      ? value
      : usage();
  const integer = (value, max) =>
    /^\d+$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= max
      ? Number(value)
      : usage();
  if (['status', 'jobs', 'targets'].includes(command)) {
    if (rest.length) usage();
    const snapshot = await request('status');
    if (command !== 'status') return snapshot[command];
    const { settings, totals, runtime } = snapshot;
    return { settings, totals, runtime };
  }
  if (command === 'directory') {
    const directory = await request('directory');
    const query = rest.join(' ').toLocaleLowerCase();
    return Object.fromEntries(
      Object.entries(directory).map(([kind, entries]) => [
        kind,
        entries.filter(
          (entry) =>
            entry.name.toLocaleLowerCase().includes(query) ||
            entry.id === query,
        ),
      ]),
    );
  }
  if (['add-teacher', 'add-series'].includes(command)) {
    const upstreamId = id(rest[0]);
    const options = {};
    for (let i = 1; i < rest.length; i += 2) {
      const key = rest[i];
      if (
        !['--limit', '--teacher'].includes(key) ||
        key in options ||
        rest[i + 1] === undefined
      )
        usage();
      options[key] = rest[i + 1];
    }
    const limit = integer(options['--limit'], 10000);
    if (command === 'add-teacher' && options['--teacher']) usage();
    const kind = command === 'add-teacher' ? 'teacher' : 'series';
    const teacherId =
      options['--teacher'] === undefined ? undefined : id(options['--teacher']);
    // Preserve an existing series restriction when changing its budget.
    const previous = (await request('status')).targets.find(
      (target) => target.kind === kind && target.upstream_id === upstreamId,
    );
    return request('targets', {
      kind,
      upstreamId,
      limit,
      enabled: true,
      teacherId: teacherId ?? previous?.teacher_filter ?? undefined,
    });
  }
  if (['enable', 'disable', 'budget'].includes(command)) {
    const targetId = uuid(rest[0]);
    if (rest.length !== (command === 'budget' ? 2 : 1)) usage();
    const limit = command === 'budget' ? integer(rest[1], 10000) : undefined;
    const target = (await request('status')).targets.find(
      (item) => item.id === targetId,
    );
    if (!target)
      throw new Error('Selection not found. Run yutorah-queue targets.');
    return request('targets', {
      kind: target.kind,
      upstreamId: target.upstream_id,
      limit: limit ?? target.recording_limit,
      enabled: command === 'budget' ? target.enabled : command === 'enable',
      teacherId: target.teacher_filter ?? undefined,
    });
  }
  if (command === 'scan') {
    if (rest.length > 1) usage();
    return request('scan', { pages: integer(rest[0] ?? '2', 10) });
  }
  if (['start', 'pause'].includes(command)) {
    if (rest.length) usage();
    return request(command === 'pause' ? 'stop' : 'start', {});
  }
  if (['retry', 'cancel'].includes(command)) {
    const jobId = uuid(rest[0]);
    if (rest.length !== 1 && !(rest.length === 2 && rest[1] === '--notes'))
      usage();
    return request('jobs', {
      id: jobId,
      action: command,
      kind: rest[1] === '--notes' ? 'notes' : 'transcription',
    });
  }
  if (command === 'content') {
    if (rest.length !== 1) usage();
    return request(`content?id=${id(rest[0])}`);
  }
  if (['model', 'notes'].includes(command)) {
    if (rest.length !== 1) usage();
    if (command === 'notes' && !['on', 'off'].includes(rest[0])) usage();
    const { settings, runtime } = await request('status');
    if (command === 'model' && !runtime.models.includes(rest[0]))
      throw new Error(
        'Model is not advertised by the connected account. Run yutorah-queue status.',
      );
    return request('settings', {
      ...settings,
      ...(command === 'model'
        ? { model: rest[0] }
        : { notes_enabled: rest[0] === 'on' }),
    });
  }
  usage();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await control(process.argv.slice(2));
    process.stdout.write(
      typeof result === 'string'
        ? result
        : JSON.stringify(result, null, 2) + '\n',
    );
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
