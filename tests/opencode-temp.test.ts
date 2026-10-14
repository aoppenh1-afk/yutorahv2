import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NotesQueue } from '../packages/notes-only/src/queue.js';
import { OpenCodeServer } from '../packages/opencode-acp/src/server.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
async function setup(t: test.TestContext, failure?: 'health' | 'version') {
  const root = await mkdtemp(join(tmpdir(), 'opencode-temp-test-'));
  const runtime = join(root, 'runtime');
  const executable = join(root, 'opencode');
  await writeFile(
    executable,
    `#!/bin/sh\n${failure ? `export OPENCODE_FIXTURE_BAD_${failure.toUpperCase()}=1\n` : ''}exec ${quote(process.execPath)} ${quote(resolve('tests/fixtures/opencode-server.mjs'))} "$@"\n`,
    { mode: 0o700 },
  );
  const queue = new NotesQueue(join(root, 'queue.sqlite'));
  const server = new OpenCodeServer(
    { executable, root: runtime, deadlineMs: 1000, catalogTtlMs: 60000 },
    queue,
  );
  t.after(async () => {
    await server.close();
    queue.close();
    await rm(root, { recursive: true, force: true });
  });
  const launches = async () =>
    (await readFile(join(runtime, 'native-launches.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            command: string;
            tmpdir: string | null;
            bunTmpdir: string | null;
            library: string;
          },
      );
  return { runtime, server, launches };
}

void test('server version checks and serving keep native libraries in private scratch and remove them after stopping', async (t) => {
  const { runtime, server, launches } = await setup(t);
  await server.start();
  const records = await launches();
  assert.deepEqual(
    records.map((r) => r.command),
    ['--version', 'serve'],
  );
  for (const record of records) {
    assert.equal(record.tmpdir, join(runtime, 'tmp'));
    assert.equal(record.bunTmpdir, record.tmpdir);
    assert.equal((await stat(record.library)).isFile(), true);
  }
  assert.equal((await stat(join(runtime, 'tmp'))).mode & 0o777, 0o700);
  await server.close();
  await assert.rejects(stat(join(runtime, 'tmp')), { code: 'ENOENT' });
  for (const record of records)
    await assert.rejects(stat(record.library), { code: 'ENOENT' });
});

void test('restarting a killed server reaps its old scratch before extracting a new library', async (t) => {
  const { runtime, server, launches } = await setup(t);
  await server.start();
  const oldLibraries = (await launches()).map((r) => r.library);
  const { pid } = JSON.parse(
    await readFile(join(runtime, 'owner.json'), 'utf8'),
  ) as { pid: number };
  process.kill(pid, 'SIGKILL');
  let stopped = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      stopped = true;
      break;
    }
    await delay(20);
  }
  assert.equal(stopped, true, 'the old server must exit before recovery');
  // A fresh owner also covers recovery after the coordinator itself disappears.
  const recovered = new OpenCodeServer(server.config, server.queue);
  t.after(() => recovered.close());
  await recovered.start();
  for (const path of oldLibraries)
    await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal((await readdir(join(runtime, 'tmp'))).length, 2);
  await recovered.close();
  // Forget the old wrapper before teardown: it no longer owns a live server.
  await server.close();
  await assert.rejects(stat(join(runtime, 'tmp')), { code: 'ENOENT' });
});

for (const failure of ['health', 'version'] as const) {
  void test(`a rejected server ${failure} check cleans extracted native libraries`, async (t) => {
    const { runtime, server, launches } = await setup(t, failure);
    await assert.rejects(server.start(), { code: 'configuration' });
    assert.equal((await launches()).length, failure === 'health' ? 2 : 1);
    await assert.rejects(stat(join(runtime, 'tmp')), { code: 'ENOENT' });
    for (const record of await launches())
      await assert.rejects(stat(record.library), { code: 'ENOENT' });
  });
}
