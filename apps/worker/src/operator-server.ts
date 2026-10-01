import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import type { TranscriptionStore } from '../../../packages/transcription/src/store.js';
import { NotesStore } from '../../../packages/transcription/src/notes-store.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import { catalogDirectory } from '../../../packages/yutorah-core/src/media.js';
import {
  SelectionStore,
  type OperatorSettings,
  type Target,
} from './selections.js';
import { OperatorRuntime } from './operator-runtime.js';

const equal = (a: string, b: string) =>
  timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    !req.headers['content-type']?.startsWith('application/json') ||
    req.headers['x-operator-request'] !== '1'
  )
    throw new Failure('configuration');
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 16 * 1024) throw new Failure('configuration');
  }
  const result: unknown = JSON.parse(text || '{}');
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Failure('configuration');
  return result as Record<string, unknown>;
}
export function createOperatorServer(
  store: TranscriptionStore,
  runtime: OperatorRuntime,
  token: string,
  publicDir: string,
  loadDirectory = catalogDirectory,
): Server {
  if (Buffer.byteLength(token) < 32) throw new Failure('configuration');
  const cookie = randomBytes(32).toString('hex');
  const selections = new SelectionStore(store.pool);
  const notes = new NotesStore(store.pool);
  let directory: Awaited<ReturnType<typeof catalogDirectory>> | undefined;
  let directoryUntil = 0;
  const getDirectory = async () => {
    if (directory && Date.now() < directoryUntil) return directory;
    directory = await loadDirectory(AbortSignal.timeout(30_000));
    directoryUntil = Date.now() + 3600_000;
    return directory;
  };
  const files = new Map([
    ['/', ['operator.html', 'text/html']],
    ['/operator.js', ['operator.js', 'text/javascript']],
    ['/operator.css', ['operator.css', 'text/css']],
  ]);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const file = files.get(url.pathname);
      if (req.method === 'GET' && file) {
        res.setHeader('Content-Type', `${file[1]}; charset=utf-8`);
        res.end(await readFile(join(publicDir, file[0])));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/operator/session') {
        const data = await body(req);
        if (typeof data.token !== 'string' || !equal(data.token, token)) {
          reply(401, { error: 'Invalid operator key.' });
          return;
        }
        res.setHeader(
          'Set-Cookie',
          `yutorah_operator=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`,
        );
        reply(200, { ok: true });
        return;
      }
      const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '';
      const session =
        req.headers.cookie
          ?.split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('yutorah_operator='))
          ?.slice('yutorah_operator='.length) ?? '';
      if (!equal(bearer, token) && !equal(session, cookie)) {
        reply(401, { error: 'Sign in with your operator key.' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/operator/status') {
        reply(200, {
          ...(await selections.snapshot()),
          runtime: await runtime.status(),
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/operator/directory') {
        reply(200, await getDirectory());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/operator/content') {
        const id = url.searchParams.get('id') ?? '';
        if (!/^\d{1,12}$/.test(id)) {
          reply(400, { error: 'Invalid shiur.' });
          return;
        }
        const content = await store.content(id);
        reply(
          content ? 200 : 404,
          content ?? { error: 'No completed transcript yet.' },
        );
        return;
      }
      if (req.method !== 'POST') {
        reply(404, { error: 'Not found.' });
        return;
      }
      const data = await body(req);
      if (url.pathname === '/api/operator/targets') {
        const kind = data.kind as Target['kind'];
        const directory = await getDirectory();
        const entity = (
          kind === 'teacher'
            ? directory.teachers
            : kind === 'series'
              ? directory.series
              : []
        ).find((r) => r.id === data.upstreamId);
        if (!entity) {
          reply(400, {
            error: 'Select a teacher or series from the directory.',
          });
          return;
        }
        const teacherId =
          typeof data.teacherId === 'string' ? data.teacherId : undefined;
        if (
          teacherId &&
          (kind !== 'series' ||
            !directory.teachers.some((t) => t.id === teacherId))
        ) {
          reply(400, { error: 'Select a teacher from the directory.' });
          return;
        }
        await selections.saveTarget({
          kind,
          upstreamId: entity.id,
          name: entity.name,
          limit: Number(data.limit),
          enabled: data.enabled as boolean,
          teacherId,
        });
      } else if (url.pathname === '/api/operator/settings') {
        await runtime.change(async () => {
          const settings = data as unknown as OperatorSettings;
          const status = await runtime.status();
          if (!status.models.includes(settings.model))
            throw new Failure('configuration');
          await runtime.stop();
          await selections.saveSettings(settings);
          if (settings.worker_enabled) await runtime.start();
        });
      } else if (url.pathname === '/api/operator/scan') {
        reply(200, await runtime.scan(Number(data.pages ?? 2)));
        return;
      } else if (url.pathname === '/api/operator/start')
        await runtime.change(() => runtime.start());
      else if (url.pathname === '/api/operator/stop')
        await runtime.change(() => runtime.stop());
      else if (url.pathname === '/api/operator/auth')
        await runtime.change(() =>
          runtime.authenticate(data.interactive !== false),
        );
      else if (url.pathname === '/api/operator/auth-cancel')
        await runtime.change(() => runtime.cancelAuth());
      else if (url.pathname === '/api/operator/jobs') {
        if (
          typeof data.id !== 'string' ||
          !uuid.test(data.id) ||
          !['retry', 'cancel'].includes(String(data.action))
        ) {
          reply(400, { error: 'Invalid job action.' });
          return;
        }
        const jobs = data.kind === 'notes' ? notes : store;
        if (data.action === 'retry') await jobs.retry(data.id);
        else await jobs.cancel(data.id);
      } else {
        reply(404, { error: 'Not found.' });
        return;
      }
      reply(200, { ok: true });
    } catch (error) {
      reply(
        (error instanceof Failure && error.code === 'configuration') ||
          error instanceof SyntaxError
          ? 400
          : 503,
        {
          error:
            error instanceof Failure && error.code === 'configuration'
              ? 'Check your selection, recording limit, model, or current connection.'
              : 'This operation could not finish. Try again.',
        },
      );
    }
  });
}
export async function serveOperator(
  store: TranscriptionStore,
  runtime: OperatorRuntime,
  token: string,
  publicDir: string,
  port: number,
  signal: AbortSignal,
) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Failure('configuration');
  const server = createOperatorServer(store, runtime, token, publicDir);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    if ((await new SelectionStore(store.pool).settings()).worker_enabled)
      await runtime.start();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    await runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
