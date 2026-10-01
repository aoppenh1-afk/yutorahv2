import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const source = resolve('deploy/transcription/start-content-tunnel.sh');
const url = 'https://review-ready.trycloudflare.com';

async function fixture(ready = true) {
  const root = await mkdtemp(join(tmpdir(), 'yutorah-tunnel-test-'));
  const binary = join(root, 'bin/cloudflared');
  const launcher = join(root, 'launcher.sh');
  await mkdir(join(root, 'bin'));
  // Keep the actual Linux /proc, flock, root guard and runuser execution. Only
  // redirect state to this fixture and shorten its readiness timeout.
  await writeFile(launcher, (await readFile(source, 'utf8'))
    .replaceAll('/run/yutorah-content-tunnel', join(root, 'tunnel'))
    .replaceAll('/var/log/yutorah-content-tunnel.log', join(root, 'tunnel.log'))
    .replaceAll('yutorah-search', userInfo().username)
    .replaceAll('attempt<60', 'attempt<20')
    .replaceAll('sleep 1', 'sleep 0.05'));
  await writeFile(binary, `#!/usr/bin/env bash
set -euo pipefail
root=$(dirname "$(dirname "$0")")
printf '%s\\n' "$PPID" >> "$root/started-pids"
while [ ! -f "$root/ready" ] && [ ! -f "$root/ready-$PPID" ]; do sleep 0.05; done
if [ -f "$root/url-$PPID" ]; then cat "$root/url-$PPID"; else printf '%s\\n' '${url}'; fi
while true; do sleep 0.05; done
`, { mode: 0o755 });
  if (ready) await writeFile(join(root, 'ready'), '');
  const run = () => exec('sudo', ['-n', 'bash', launcher, root], {
    env: { ...process.env, CLOUDFLARED_BIN: binary }, timeout: 5000,
  });
  const read = (name: string) => readFile(join(root, name), 'utf8');
  const write = async (name: string, value: string) => {
    // State created by the root launcher is read-only to the test runner.
    const next = join(root, name + '.test-next');
    await writeFile(next, value);
    await rename(next, join(root, name));
  };
  return {
    root, run, read, write,
    async close() {
      const pids = (await read('started-pids').catch(() => '')).trim().split(/\s+/);
      for (const pid of pids.filter(Boolean)) {
        const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
        if (args.split('\0').includes(binary))
          await exec('sudo', ['-n', 'kill', '-TERM', '--', pid]).catch(() => {});
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

void test('tunnel launcher replaces an unrelated live PID without killing it', async () => {
  const f = await fixture();
  try {
    await f.write('tunnel.pid', String(process.pid));
    await f.write('tunnel-url', 'https://obsolete.trycloudflare.com\n');
    assert.match((await f.run()).stdout, new RegExp(url.replaceAll('.', '\\.')));
    assert.notEqual((await f.read('tunnel.pid')).trim(), String(process.pid));
    process.kill(process.pid, 0);
    assert.equal((await f.read('tunnel-url')).trim(), url);
    assert.match((await f.read('tunnel.start')).trim(), /^\d+$/);
  } finally { await f.close(); }
});

void test('tunnel launcher checks start time even when the command matches', async () => {
  const f = await fixture();
  try {
    await f.run();
    const first = await f.read('tunnel.pid');
    await f.write('tunnel.start', '0\n');
    await f.run();
    assert.notEqual(await f.read('tunnel.pid'), first);
  } finally { await f.close(); }
});

void test('tunnel launcher preserves a verified tunnel and upgrades legacy PID state', async () => {
  const f = await fixture();
  try {
    await f.run();
    const first = await f.read('tunnel.pid');
    await rm(join(f.root, 'tunnel.start'));
    assert.ok((await f.run()).stdout.includes(url));
    assert.equal(await f.read('tunnel.pid'), first);
    assert.match((await f.read('tunnel.start')).trim(), /^\d+$/);
    assert.equal((await f.read('started-pids')).trim().split(/\s+/).length, 1);
  } finally { await f.close(); }
});

void test('a retry fails until an existing tunnel has an address, then reuses it', async () => {
  const f = await fixture(false);
  try {
    await assert.rejects(f.run(), (e: Error & { code?: number; stdout?: string }) =>
      e.code === 1 && !e.stdout?.includes('already running'));
    const first = await f.read('tunnel.pid');
    await assert.rejects(f.run(), (e: Error & { code?: number }) => e.code === 1);
    assert.equal(await f.read('tunnel.pid'), first);
    await f.write('ready', '');
    assert.ok((await f.run()).stdout.includes(url));
    assert.equal(await f.read('tunnel.pid'), first);
    assert.equal((await f.read('tunnel-url')).trim(), url);
    assert.equal((await f.read('started-pids')).trim().split(/\s+/).length, 1);
    await rm(join(f.root, 'tunnel-url'));
    assert.ok((await f.run()).stdout.includes(url));
    assert.equal((await f.read('tunnel-url')).trim(), url);
    assert.equal(await f.read('tunnel.pid'), first);
  } finally { await f.close(); }
});

void test('concurrent tunnel launchers share a single process and address', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([f.run(), f.run()]);
    assert.ok(results.every(result => result.stdout.includes(url)));
    assert.equal((await f.read('started-pids')).trim().split(/\s+/).length, 1);
  } finally { await f.close(); }
});

void test('a rejected live process cannot publish its URL through the replacement log', async () => {
  const f = await fixture(false);
  try {
    await assert.rejects(f.run(), (e: Error & { code?: number }) => e.code === 1);
    const oldPid = (await f.read('tunnel.pid')).trim();
    const oldUrl = 'https://old-review.trycloudflare.com';
    await f.write(`url-${oldPid}`, oldUrl + '\n');
    await f.write('tunnel.start', '0\n');
    const replacement = f.run();
    // Attach the rejection handler before releasing either fixture process.
    const stillAwaitingUrl = assert.rejects(replacement,
      (e: Error & { code?: number }) => e.code === 1);
    let newPid = oldPid;
    for (let attempt = 0; attempt < 100; attempt++) {
      const pids = (await f.read('started-pids')).trim().split(/\s+/);
      if (pids.length === 2) { newPid = pids[1]; break; }
      await delay(10);
    }
    assert.notEqual(newPid, oldPid, 'replacement process started');
    await f.write(`ready-${oldPid}`, '');
    await stillAwaitingUrl;
    await f.write(`ready-${newPid}`, '');
    const result = await f.run();
    assert.ok(result.stdout.includes(url));
    assert.ok(!result.stdout.includes(oldUrl));
    assert.equal((await f.read('tunnel-url')).trim(), url);
    assert.equal((await f.read('tunnel.pid')).trim(), newPid);
  } finally { await f.close(); }
});
