import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  ACPClient,
  authorizationURL,
  Lines,
} from '../../../packages/antigravity-acp/src/client.js';
import {
  prepareProfile,
  validateProfile,
  withRuntime,
} from '../../../packages/antigravity-acp/src/runtime.js';
import { Failure } from '../../../packages/antigravity-acp/src/errors.js';
import { digest } from '../../../packages/transcription/src/fingerprint.js';
import { transcriptionPrompt } from '../../../packages/transcription/src/prompt.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';

const fixture = resolve('apps/worker/test/fixtures/acp.mjs');
const skill = await readFile(
  'packages/transcription/skills/lectern-transcription/SKILL.md',
  'utf8',
);
const prompt = transcriptionPrompt(
  skill,
  defaultSettings,
  'lecture-audio.wav',
  0,
  1,
);
function client(
  behavior = 'normal',
  signal = new AbortController().signal,
  marker = '',
) {
  return new ACPClient(
    {
      executable: process.execPath,
      args: [fixture, behavior, marker],
      cwd: tmpdir(),
      version: '1.2.1',
      env: { EXPECT_SKILL_HASH: digest(skill), NODE_ENV: 'test' },
    },
    signal,
    undefined,
    80,
  );
}
const code = (expected: string) => (e: unknown) =>
  e instanceof Failure && e.code === expected;
void test('ACP correlates concurrent replies and preserves fragmented Hebrew/native audio/full skill', async () => {
  const c = client('fragmented');
  try {
    await c.initialize();
    await c.authenticate();
    await c.session(tmpdir(), defaultSettings.model);
    const values = await Promise.all([
      c.request('echo', { value: 'first', delay: 20 }),
      c.request('echo', { value: 'second', delay: 1 }),
    ]);
    assert.deepEqual(values, [{ value: 'first' }, { value: 'second' }]);
    const text = await c.prompt(
      prompt,
      Buffer.from('fixture audio'),
      'audio/wav',
      1000,
    );
    assert.equal(
      text,
      '[00:01] The גמ׳ asks on תוס׳.\n[00:04] Student: What about רש״י?',
    );
    assert.equal(c.diagnostics.thoughtChunks, 1);
  } finally {
    await c.close();
  }
});
void test('transcription policy is active before initialization', async () => {
  const c = client('early_permission');
  try {
    await assert.rejects(c.initialize(), code('off_task'));
  } finally {
    await c.close();
  }
});
for (const [behavior, expected] of [
  ['tool_call', 'off_task'],
  ['tool_call_update', 'off_task'],
  ['permission', 'off_task'],
  ['input', 'off_task'],
  ['truncated', 'incomplete_output'],
  ['oversized', 'output_limit'],
  ['oversized_line', 'output_limit'],
  ['crash', 'process_exit'],
  ['hang', 'timeout'],
  ['usage_limit', 'quota_exhausted'],
  ['quota_rpc', 'quota_exhausted'],
]) {
  void test(`ACP rejects ${behavior}`, async () => {
    const c = client(behavior);
    try {
      await c.initialize();
      await c.authenticate();
      await c.session(tmpdir(), defaultSettings.model);
      await assert.rejects(
        c.prompt(
          prompt,
          Buffer.from('fixture audio'),
          'audio/wav',
          behavior === 'hang' ? 40 : 2000,
        ),
        code(expected),
      );
    } finally {
      await c.close();
    }
  });
}
void test('medium model also sets medium thinking explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-model-'));
  const marker = join(root, 'config.jsonl');
  const c = client('model_config', new AbortController().signal, marker);
  try {
    await c.initialize();
    await c.session(tmpdir(), 'gemini-3.8-flash-medium');
    const changes = (await readFile(marker, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      changes.map(({ configId, value }) => ({ configId, value })),
      [
        { configId: 'model', value: 'gemini-3.8-flash-medium' },
        { configId: 'thought_level', value: 'medium' },
      ],
    );
  } finally {
    await c.close();
    await rm(root, { recursive: true, force: true });
  }
});
void test('model and mode selection fail rather than silently changing settings', async () => {
  for (const behavior of ['normal', 'bad_mode']) {
    const c = client(behavior);
    try {
      await c.initialize();
      await assert.rejects(
        c.session(
          tmpdir(),
          behavior === 'normal' ? 'unknown-model' : defaultSettings.model,
        ),
        code('configuration'),
      );
    } finally {
      await c.close();
    }
  }
});
void test('background OAuth request fails promptly without exposing its URL', async () => {
  const c = client('auth');
  try {
    await c.initialize();
    await assert.rejects(c.authenticate(), code('auth_required'));
  } finally {
    await c.close();
  }
});
void test('OAuth validation permits only the Google loopback code flow', () => {
  const valid =
    'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A34567%2F';
  assert.equal(authorizationURL(valid).port, 34567);
  for (const url of [
    valid.replace('accounts.google.com', 'evil.example'),
    valid + '&state=other',
    valid.replace('127.0.0.1', '192.168.1.2'),
    valid.replace('34567', '80'),
  ])
    assert.throws(() => authorizationURL(url), code('auth_required'));
});
void test('line bounds recover without retaining an oversized stderr payload', () => {
  const values: string[] = [];
  let overflow = 0;
  const lines = new Lines(
    8,
    (s) => values.push(s),
    () => overflow++,
  );
  lines.push(Buffer.from('123456789'));
  lines.push(Buffer.from('00\nhello\n'));
  assert.equal(overflow, 1);
  assert.deepEqual(values, ['hello']);
});
void test('cancellation and timeout kill a termination-resistant descendant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-child-'));
  const marker = join(root, 'pid');
  const abort = new AbortController();
  const c = client('child', abort.signal, marker);
  try {
    await c.initialize();
    await c.session(tmpdir(), defaultSettings.model);
    const result = c.prompt(
      prompt,
      Buffer.from('fixture audio'),
      'audio/wav',
      2000,
    );
    const rejection = assert.rejects(result, code('cancelled'));
    for (let i = 0; i < 100; i++) {
      if (await stat(marker).catch(() => null)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const pid = Number(await readFile(marker, 'utf8'));
    abort.abort(new Failure('cancelled'));
    await rejection;
    await c.close();
    const proc = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!proc || proc.split(' ')[2] === 'Z', 'child must have exited');
  } finally {
    await c.close();
    await rm(root, { recursive: true, force: true });
  }
});
void test('managed profile validates hooks without overwriting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-profile-'));
  try {
    await prepareProfile(root);
    await validateProfile(root);
    const file = join(root, 'antigravity-acp/settings.json');
    const text =
      '{"auth":{"type":"oauth-personal"},"hooks":{"afterAgent":"unsafe"}}';
    await writeFile(file, text);
    await assert.rejects(prepareProfile(root), code('configuration'));
    assert.equal(await readFile(file, 'utf8'), text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test('runtime removes its run directory when client construction is cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-run-'));
  const profile = join(root, 'profile');
  const scratch = join(root, 'scratch');
  try {
    await prepareProfile(profile);
    const controller = new AbortController();
    controller.abort(new Failure('cancelled'));
    await assert.rejects(
      withRuntime(
        { directory: root, profile, scratch },
        controller.signal,
        async () => assert.fail('the client must not start'),
      ),
      code('cancelled'),
    );
    assert.deepEqual(await readdir(scratch), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('runtime removes stored audio conversations after success and failed sessions while preserving credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-session-cleanup-'));
  const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  const profile = join(root, 'profile');
  const runtime = { directory: root, profile, scratch: join(root, 'scratch') };
  try {
    await prepareProfile(profile);
    const token = join(profile, 'antigravity-acp/acp_token.json');
    await writeFile(token, 'credential sentinel');
    await writeFile(
      join(root, 'agy_acp_server.par'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} session_storage\n`,
      { mode: 0o700 },
    );
    for (const scenario of [
      'success',
      'failed',
      'cancelled',
      'invalid_model',
    ] as const) {
      const controller = new AbortController();
      const work = withRuntime(
        runtime,
        controller.signal,
        async (c, workspace) => {
          await c.authenticate();
          await c.session(
            workspace,
            scenario === 'invalid_model'
              ? 'unknown-model'
              : defaultSettings.model,
          );
          // A caller can create another session before returning; both must be owned.
          await c.session(workspace, defaultSettings.model);
          if (scenario === 'failed') throw new Failure('provider');
          if (scenario === 'cancelled') {
            controller.abort(new Failure('cancelled'));
            throw new Failure('cancelled');
          }
        },
      );
      if (scenario === 'success') await work;
      else await assert.rejects(work, Failure);
      assert.deepEqual(
        await readdir(join(profile, 'antigravity-acp/conversations')),
        [],
        `${scenario} must remove the recorded databases and their sidecars`,
      );
      assert.deepEqual(
        await readdir(join(profile, 'antigravity-acp/brain')),
        [],
      );
      assert.equal(await readFile(token, 'utf8'), 'credential sentinel');
      assert.deepEqual(await readdir(runtime.scratch), []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
