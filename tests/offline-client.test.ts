import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import ts from 'typescript';

const source = ts.transpileModule(
  await readFile(new URL('../lib/offline-client.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function client(registration: object) {
  const exports: {
    registerOfflineWorker?: () => Promise<unknown>;
    ensureOfflineReady?: () => Promise<void>;
  } = {};
  vm.runInNewContext(source, {
    exports,
    window: { isSecureContext: true },
    navigator: {
      serviceWorker: {
        register: async () => registration,
        ready: Promise.resolve(registration),
      },
    },
    MessageChannel,
    setTimeout,
    clearTimeout,
    Promise,
    Error,
  });
  return exports as Required<typeof exports>;
}
void test('the old push worker is never used before the new offline worker activates', async () => {
  const installing = Object.assign(new EventTarget(), { state: 'installing' });
  let oldMessages = 0,
    newMessages = 0;
  const registration = {
    installing,
    active: {
      postMessage() {
        oldMessages++;
      },
    },
  };
  const api = client(registration);
  const preparing = api.ensureOfflineReady();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(oldMessages, 0);
  registration.active = {
    postMessage(_message?: unknown, ports?: MessagePort[]) {
      newMessages++;
      ports![0].postMessage({ ready: true });
    },
  };
  installing.state = 'activated';
  installing.dispatchEvent(new Event('statechange'));
  await preparing;
  assert.equal(newMessages, 1);
  assert.equal(oldMessages, 0);
});
void test('a failed installation rejects instead of promising unavailable offline playback', async () => {
  const installing = Object.assign(new EventTarget(), { state: 'installing' });
  const api = client({ installing, active: {} });
  const result = api.registerOfflineWorker();
  await Promise.resolve();
  await Promise.resolve();
  installing.state = 'redundant';
  installing.dispatchEvent(new Event('statechange'));
  await assert.rejects(result, /Could not save the app/);
});
