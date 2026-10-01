import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  prepareProfile,
  withRuntime,
} from '../../../packages/antigravity-acp/src/runtime.js';
import {
  pruneConversations,
  recoverConversations,
} from '../../../packages/antigravity-acp/src/session-cleanup.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';

void test('closing one runtime preserves an active peer conversation in the shared Google profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-peer-cleanup-'));
  const profile = join(root, 'profile');
  const config = { directory: root, profile, scratch: join(root, 'scratch') };
  const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let peer: Promise<void> | undefined;
  try {
    await prepareProfile(profile);
    await writeFile(
      join(root, 'agy_acp_server.par'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('apps/worker/test/fixtures/acp.mjs'))} session_storage\n`,
      { mode: 0o700 },
    );
    peer = withRuntime(
      config,
      AbortSignal.timeout(15000),
      async (client, workspace) => {
        await client.session(workspace, defaultSettings.model);
        ready();
        await gate;
      },
    );
    await Promise.race([
      started,
      peer.then(() => assert.fail('peer must remain active')),
    ]);
    const conversations = join(profile, 'antigravity-acp/conversations');
    const ownedByPeer = await readdir(conversations);
    assert.equal(ownedByPeer.length, 4);
    await withRuntime(
      config,
      new AbortController().signal,
      async (client, workspace) => {
        await client.session(workspace, defaultSettings.model);
        assert.equal((await readdir(conversations)).length, 8);
      },
    );
    assert.deepEqual(await readdir(conversations), ownedByPeer);
    release();
    await peer;
    assert.deepEqual(await readdir(conversations), []);
    assert.deepEqual(await readdir(config.scratch), []);
  } finally {
    release();
    await peer?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

void test('legacy pruning protects recent sidecars, brain work, unknown files, and credentials; crash recovery removes recorded sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-legacy-cleanup-'));
  const base = join(root, 'antigravity-acp');
  const conversations = join(base, 'conversations');
  const old = new Date(Date.now() - 2 * 86400_000);
  const ids = [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333',
  ];
  try {
    await mkdir(conversations, { recursive: true });
    const token = join(base, 'acp_token.json');
    await writeFile(token, 'credential sentinel');
    await writeFile(join(conversations, 'unknown.db'), 'keep');
    for (const id of ids) {
      for (const suffix of ['.db', '.db-wal', '.db-shm', '.meta']) {
        const path = join(conversations, id + suffix);
        await writeFile(path, 'stored audio fixture');
        await utimes(path, old, old);
      }
    }
    await utimes(
      join(conversations, ids[1] + '.db-wal'),
      new Date(),
      new Date(),
    );
    await mkdir(join(base, 'brain', ids[2]), { recursive: true });
    await pruneConversations(root);
    assert.ok(
      !(await readdir(conversations)).some((name) => name.startsWith(ids[0])),
    );
    assert.equal(
      (await readdir(conversations)).filter((name) => name.startsWith(ids[1]))
        .length,
      4,
    );
    assert.equal(
      (await readdir(conversations)).filter((name) => name.startsWith(ids[2]))
        .length,
      4,
    );
    const run = join(root, 'acp-abandoned');
    await mkdir(run);
    await writeFile(
      join(run, 'sessions.json'),
      JSON.stringify({ version: 1, ids: [ids[1], '../acp_token.json'] }),
    );
    await recoverConversations(root, run);
    assert.ok(
      !(await readdir(conversations)).some((name) => name.startsWith(ids[1])),
    );
    assert.equal(
      (await readdir(conversations)).filter((name) => name.startsWith(ids[2]))
        .length,
      4,
    );
    assert.equal(
      await readFile(join(conversations, 'unknown.db'), 'utf8'),
      'keep',
    );
    assert.equal(await readFile(token, 'utf8'), 'credential sentinel');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
