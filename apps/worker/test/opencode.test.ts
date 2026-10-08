import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  OpenCodeClient,
  withOpenCode,
  FREE_NOTES_MODEL,
  notesAgentConfig,
  recoverOpenCode,
} from '../../../packages/opencode-acp/src/runtime.js';
const fixture = resolve('apps/worker/test/fixtures/opencode.mjs');
void test('OpenCode v2 is rejected before launching an incompatible notes runtime', async () => {
  await assert.rejects(
    withOpenCode(
      { executable: '/missing-opencode', scratch: tmpdir(), version: '2.0.24' },
      new AbortController().signal,
      async () => {},
    ),
    { code: 'configuration' },
  );
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
function client(behavior = 'normal') {
  return new OpenCodeClient(
    {
      executable: process.execPath,
      args: [fixture, behavior],
      cwd: tmpdir(),
      env: { NODE_ENV: 'test' },
      version: '1.18.33',
    },
    new AbortController().signal,
    20,
  );
}
void test('OpenCode selects and confirms Muse Free without Google authentication or audio support', async () => {
  const c = client();
  try {
    await c.initialize();
    await c.authenticate();
    assert.deepEqual(await c.session(tmpdir()), [FREE_NOTES_MODEL]);
    assert.match(await c.textPrompt('Supplied notes skill and source'), /רש״י/);
    await assert.rejects(c.session(tmpdir(), 'opencode/muse-spark-1.3'), {
      code: 'configuration',
    });
  } finally {
    await c.close();
  }
});

void test('failed cleanup after a timeout retains an ID ledger and recovery deletes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-recovery-test-'));
  const marker = join(root, 'events.jsonl');
  const failDelete = join(root, 'fail-delete');
  await writeFile(failDelete, 'busy');
  const executable = join(root, 'opencode');
  const config = { executable, scratch: join(root, 'scratch') };
  await writeFile(
    executable,
    `#!/bin/sh\nexport OPENCODE_FIXTURE_BEHAVIOR=hang\nexport OPENCODE_FIXTURE_MARKER=${quote(marker)}\nexport OPENCODE_FIXTURE_FAIL_DELETE_MARKER=${quote(failDelete)}\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
    { mode: 0o700 },
  );
  try {
    await assert.rejects(
      withOpenCode(
        config,
        new AbortController().signal,
        async (c, workspace) => {
          await c.session(workspace);
          await c.textPrompt('full lecture source', 50);
        },
      ),
      { code: 'timeout' },
    );
    const abandoned = await readdir(config.scratch);
    assert.equal(abandoned.length, 1);
    const workspace = join(config.scratch, abandoned[0]);
    const ledger = JSON.parse(
      await readFile(join(workspace, 'sessions.json'), 'utf8'),
    );
    assert.deepEqual(ledger.ids, ['opencode-fixture']);
    await rm(failDelete);
    await recoverOpenCode(config, workspace, new AbortController().signal);
    assert.deepEqual(await readdir(config.scratch), []);
    const events = (await readFile(marker, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some(
        (event) =>
          event.method === 'session/delete' &&
          event.sessionId === 'opencode-fixture',
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const [behavior, code] of [
  ['wrong_identity', 'configuration'],
  ['missing_model', 'configuration'],
  ['missing_mode', 'configuration'],
  ['unconfirmed_model', 'configuration'],
  ['quota', 'quota_exhausted'],
  ['auth', 'auth_required'],
  ['tool', 'off_task'],
  ['hang', 'timeout'],
]) {
  void test(`OpenCode rejects ${behavior}`, async () => {
    const c = client(behavior);
    try {
      await assert.rejects(
        (async () => {
          await c.initialize();
          await c.session(tmpdir());
          await c.textPrompt('source', 300);
        })(),
        { code },
      );
    } finally {
      await c.close();
    }
  });
}
void test('OpenCode runtime pins free helper calls, requires permission for tools, deletes the session and cleans scratch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-runtime-test-'));
  const marker = join(root, 'events.jsonl');
  const executable = join(root, 'opencode');
  const scratch = join(root, 'scratch');
  await writeFile(
    executable,
    `#!/bin/sh\nexport OPENCODE_FIXTURE_MARKER=${quote(marker)}\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
    { mode: 0o700 },
  );
  try {
    await withOpenCode(
      { executable, scratch },
      new AbortController().signal,
      async (c, workspace) => {
        const config = JSON.parse(
          await readFile(join(workspace, 'opencode.json'), 'utf8'),
        );
        assert.deepEqual(config, notesAgentConfig());
        assert.match(
          await readFile(join(workspace, '.git', 'HEAD'), 'utf8'),
          /^ref: refs\/heads\//,
        );
        await c.session(workspace);
        await c.textPrompt('full transcript and notes contract');
      },
    );
    const events = (await readFile(marker, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const config = events.find((event) => event.method === 'config');
    assert.equal(config.model, FREE_NOTES_MODEL);
    assert.equal(config.small_model, FREE_NOTES_MODEL);
    assert.equal(config.agentModel, FREE_NOTES_MODEL);
    assert.equal(config.permission['*'], 'ask');
    assert.equal(config.permission.edit, 'deny');
    assert.ok(events.some((event) => event.method === 'session/delete'));
    assert.ok(!events.some((event) => event.method === 'authenticate'));
    assert.deepEqual(await readdir(scratch), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
