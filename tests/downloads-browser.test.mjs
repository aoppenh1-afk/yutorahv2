import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';

const upstreamOrigin = process.env.TEST_ORIGIN || 'http://localhost:3025';
const origin = 'http://localhost:3027';
const state = await mkdtemp(join(tmpdir(), 'yutorah-downloads-'));
const server = process.env.TEST_ORIGIN
  ? null
  : spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '--config',
        'dist/server/wrangler.json',
        '--port',
        '3025',
        '--persist-to',
        state,
        '--inspector-port',
        '0',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
let serverOutput = '';
server?.stdout.on('data', (chunk) => {
  serverOutput = (serverOutput + chunk).slice(-5000);
});
server?.stderr.on('data', (chunk) => {
  serverOutput = (serverOutput + chunk).slice(-5000);
});
await mkdir('outputs/downloads', { recursive: true });
for (let attempt = 0; ; attempt++) {
  try {
    if ((await fetch(upstreamOrigin, { signal: AbortSignal.timeout(3000) })).ok)
      break;
  } catch {}
  if (attempt > 40 || server?.exitCode) {
    server?.kill();
    await rm(state, { recursive: true, force: true });
    throw new Error('Downloads test server could not start. ' + serverOutput);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
// A real recording checks native playback, seeking and resume, not just UI state.
const samples = 8000 * 90;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);
const shiur = {
  id: 900001,
  title: 'Offline learning recording',
  teacher: 'Rabbi Jeremy Wieder',
  teacherId: 80214,
  image: 'http://localhost:3028/rebbe.png',
  audio: 'https://download.yutorah.org/test/offline.mp3',
  url: 'https://yutorah.org/lectures/details?shiurID=900001',
  duration: 90,
  date: '2026-10-13',
  topics: [],
  category: 'Gemara',
  language: 'EN',
  series: '',
  seriesId: 0,
  description: '',
  format: 'mp3',
  materials: [],
};
let downloadMode = 'ok';
let fixtureOffline = false;
let studyMode = 'official';
let transcriptDelay = 0;
let portraitRequests = 0;
const portrait = await readFile('public/icons/yutorah-192.png');
const portraitServer = createServer((request, response) => {
  if (fixtureOffline) {
    request.socket.destroy();
    return;
  }
  portraitRequests++;
  response.writeHead(200, {
    'Content-Type': 'image/png',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600',
  });
  response.end(portrait);
});
await new Promise((resolve) =>
  portraitServer.listen(3028, 'localhost', resolve),
);
const transcript = {
  id: String(shiur.id),
  transcriptId: 'offline-fixture',
  title: shiur.title,
  teacher: shiur.teacher,
  version: 'fixture-version',
  source: 'official-yutorah',
  segments: [
    {
      startMs: 0,
      endMs: 20000,
      text: 'The saved transcript can be read without internet.',
      speaker: null,
    },
    {
      startMs: 35000,
      endMs: 60000,
      text: 'Continue learning with the second passage.',
      speaker: null,
    },
  ],
  notes: null,
};
let releaseDownload;
let releaseStudy;
// Real HTTP fixtures work for requests made through the controlled page in
// WebKit, where Playwright's request-routing hooks cannot replace SW traffic.
const fixtures = createServer(async (request, response) => {
  if (fixtureOffline) {
    request.socket.destroy();
    return;
  }
  const url = new URL(request.url, origin);
  const json = (value) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === '/api/audio-download') {
    if (downloadMode === 'reset') {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
    });
    if (downloadMode === 'blocked') {
      response.write(wav.subarray(0, 44));
      await new Promise((resolve) => {
        releaseDownload = resolve;
      });
      if (!response.destroyed) response.end(wav.subarray(44));
    } else response.end(wav);
    return;
  }
  if (url.pathname === '/api/directory') {
    json({ teachers: [], series: [], topics: [] });
    return;
  }
  if (url.pathname === '/api/home') {
    json({
      featured: [],
      recent: [shiur],
      daily: [],
      series: [],
      total: 1,
      hebrewDate: '',
      daf: '',
      nach: '',
      mishna: '',
      fetchedAt: new Date().toISOString(),
    });
    return;
  }
  if (url.pathname === '/api/shiur') {
    json({
      ...shiur,
      id: Number(url.searchParams.get('id')),
      title:
        Number(url.searchParams.get('id')) === shiur.id
          ? shiur.title
          : 'Second offline recording',
    });
    return;
  }
  if (url.pathname === '/api/related') {
    json({ items: [], partial: false });
    return;
  }
  if (url.pathname === '/api/official-study') {
    json({
      id: shiur.id,
      source: 'YUTorah',
      available: studyMode !== 'missing',
      summary: 'Saved YUTorah summary.',
      chapters: [
        {
          title: 'Opening chapter',
          start: 0,
          end: 20,
          summary: 'Saved chapter summary.',
        },
      ],
    });
    return;
  }
  if (url.pathname === '/api/transcript') {
    if (transcriptDelay)
      await new Promise((resolve) => setTimeout(resolve, transcriptDelay));
    if (studyMode === 'missing' || studyMode === 'notes-only') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Transcript unavailable' }));
    } else
      json({
        ...transcript,
        ...(studyMode === 'local'
          ? { source: undefined, notes: { status: 'queued', markdown: null } }
          : {}),
      });
    return;
  }
  if (url.pathname === '/api/study-notes') {
    if (studyMode === 'blocked')
      await new Promise((resolve) => {
        releaseStudy = resolve;
      });
    json(
      studyMode === 'missing'
        ? { status: 'unavailable', markdown: null }
        : {
            status: 'completed',
            markdown:
              '# Saved notes\n\nThese study notes remain readable offline.',
            sourceHash: 'fixture-version',
          },
    );
    return;
  }
  try {
    const result = await fetch(new URL(request.url, upstreamOrigin));
    const headers = Object.fromEntries(result.headers);
    if (headers['content-encoding']) delete headers['content-length'];
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    response.writeHead(result.status, headers);
    if (result.body) Readable.fromWeb(result.body).pipe(response);
    else response.end();
  } catch {
    response.writeHead(502);
    response.end();
  }
});
await new Promise((resolve) => fixtures.listen(3027, 'localhost', resolve));
async function setup(browser) {
  downloadMode = 'ok';
  fixtureOffline = false;
  studyMode = 'official';
  transcriptDelay = 0;
  portraitRequests = 0;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  return { context, page };
}
async function waitForSavedData(page, predicate) {
  const deadline = Date.now() + 5000;
  // waitForFunction checks the Promise's truthiness before it resolves.
  // Evaluate and await each Cache Storage read before deciding to poll again.
  while (!(await page.evaluate(predicate))) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for saved data.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function offline(context, page, value, engine = 'chromium') {
  if (engine === 'chromium') {
    await context.setOffline(value);
    return;
  }
  // Playwright WebKit's offline emulation can also block SW cache responses.
  // Drop actual HTTP connections instead, and emit the corresponding browser event.
  fixtureOffline = value;
  const update = (value) => {
    window.__fixtureOffline = value;
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => !window.__fixtureOffline,
    });
    window.dispatchEvent(new Event(value ? 'offline' : 'online'));
  };
  await context.addInitScript(update, value);
  await page.evaluate(update, value);
}
const study = (page) =>
  page.getByRole('region', {
    name: 'Transcript, notes, and sources',
    exact: true,
  });
async function startDownload(page, id = 900001) {
  await page.goto(origin + '/?shiur=' + id);
  const download = page.getByRole('button', {
    name: 'Download for offline',
    exact: true,
  });
  await download.waitFor();
  await download.click();
}
try {
  for (const { name, engine } of [
    { name: 'chromium', engine: chromium },
    { name: 'webkit', engine: webkit },
  ]) {
    await test(
      name +
        ': completed download survives offline reopening, plays, seeks and resumes',
      { timeout: 90000 },
      async () => {
        const browser = await engine.launch();
        const { context, page } = await setup(browser);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          await startDownload(page);
          await page
            .getByRole('button', { name: 'Downloaded', exact: true })
            .waitFor({ timeout: 60000 });
          await page.setViewportSize({ width: 1280, height: 844 });
          const badge = page
            .locator('.nav-button')
            .filter({ hasText: 'Downloads' })
            .locator('.nav-count');
          await badge.waitFor({ state: 'attached' });
          assert.equal(
            await badge.textContent(),
            '1',
            'the background status subscriber reflects completed downloads',
          );
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForFunction(() =>
            Boolean(navigator.serviceWorker.controller),
          );
          if (name === 'chromium') {
            const session = await context.newCDPSession(page);
            await session.send('Network.clearBrowserCache');
            await session.detach();
          }
          await offline(context, page, true, name);
          await page.reload();
          await page
            .getByRole('heading', { name: 'No internet connection' })
            .waitFor();
          await page.waitForFunction(() => {
            const image = document.querySelector('.downloaded-shiur-avatar');
            return (
              image?.tagName === 'IMG' &&
              image.complete &&
              image.naturalWidth > 0
            );
          });
          await page
            .getByRole('button', {
              name: 'Read transcript & notes',
              exact: true,
            })
            .click();
          await page
            .getByText('These study notes remain readable offline.', {
              exact: true,
            })
            .waitFor();
          await study(page)
            .getByRole('button', { name: 'Transcript', exact: true })
            .click();
          await page
            .getByText('The saved transcript can be read without internet.', {
              exact: true,
            })
            .waitFor();
          await page
            .getByRole('button', { name: 'Summaries', exact: true })
            .click();
          await page
            .getByText('Saved YUTorah summary.', { exact: true })
            .waitFor();
          await page.screenshot({
            animations: 'disabled',
            path: 'outputs/downloads/' + name + '-offline-notes.png',
          });
          await page
            .getByRole('button', { name: 'Close', exact: true })
            .click();
          await page
            .getByRole('button', { name: 'Play ' + shiur.title, exact: true })
            .click();
          await page.waitForFunction(() => {
            const audio = document.querySelector('audio');
            return audio && !audio.paused && audio.currentTime > 0;
          });
          await page.locator('audio').evaluate((audio) => {
            audio.currentTime = 35;
          });
          await page.waitForFunction(
            () => document.querySelector('audio').currentTime >= 35,
          );
          await page
            .getByRole('button', { name: 'Pause ' + shiur.title, exact: true })
            .click();
          await page.screenshot({
            animations: 'disabled',
            path: 'outputs/downloads/' + name + '-offline.png',
            fullPage: true,
          });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
          await page.close();
          const reopened = await context.newPage();
          await reopened.goto(origin + '/?view=search&q=shabbat');
          await reopened
            .getByRole('heading', { name: 'No internet connection' })
            .waitFor();
          await reopened
            .getByRole('button', { name: 'Resume ' + shiur.title, exact: true })
            .click();
          await reopened.waitForFunction(() => {
            const audio = document.querySelector('audio');
            return audio && !audio.paused && audio.currentTime >= 35;
          });
          const range = await reopened.evaluate(async () => {
            const response = await fetch('/offline-audio/900001', {
              headers: { Range: 'bytes=44-47' },
            });
            return {
              status: response.status,
              length: (await response.arrayBuffer()).byteLength,
            };
          });
          assert.deepEqual(range, { status: 206, length: 4 });
          await reopened
            .getByRole('button', { name: 'Remove download of ' + shiur.title })
            .click();
          await reopened
            .getByRole('button', { name: 'Remove download', exact: true })
            .click();
          await reopened
            .getByRole('heading', { name: 'No downloaded shiurim yet' })
            .waitFor();
          assert.equal(
            await reopened.evaluate(
              async () =>
                (await (await caches.open('yutorah-study-v1')).keys()).length,
            ),
            0,
          );
          await reopened.reload();
          await reopened
            .getByRole('heading', { name: 'No downloaded shiurim yet' })
            .waitFor();
          await reopened.screenshot({
            animations: 'disabled',
            path: 'outputs/downloads/' + name + '-empty.png',
            fullPage: true,
          });
          await offline(context, reopened, false, name);
          const retry = reopened.getByRole('button', {
            name: 'Try again',
            exact: true,
          });
          if (await retry.isVisible()) await retry.click();
          await reopened
            .getByRole('button', { name: 'Find shiurim' })
            .waitFor();
          assert.deepEqual(errors, []);
        } catch (error) {
          console.log('Original failure', error);
          const failurePage = context.pages().at(-1) || page;
          console.log(
            name + ' failure state',
            await failurePage.evaluate(async () => ({
              href: location.href,
              text: document.body.innerText,
              online: navigator.onLine,
              scripts: [...document.scripts].map((s) => s.src),
              cacheKeys: await Promise.all(
                (await caches.keys()).map(async (name) => [
                  name,
                  (await (await caches.open(name)).keys()).map((k) => k.url),
                ]),
              ),
            })),
          );
          console.log('Page errors', errors);
          await failurePage.screenshot({
            animations: 'disabled',
            path: 'outputs/downloads/' + name + '-failure.png',
            fullPage: true,
          });
          throw error;
        } finally {
          fixtureOffline = false;
          await context.close();
          await browser.close();
        }
      },
    );
  }
  for (const mode of ['local', 'notes-only', 'missing']) {
    await test(
      'offline study handles ' +
        mode +
        ' content without requiring a transcript',
      { timeout: 90000 },
      async () => {
        const browser = await chromium.launch();
        const { context, page } = await setup(browser);
        studyMode = mode;
        try {
          await startDownload(page);
          await page
            .getByRole('button', { name: 'Downloaded', exact: true })
            .waitFor({ timeout: 60000 });
          await offline(context, page, true);
          await page.reload();
          await page
            .getByRole('button', {
              name: 'Read transcript & notes',
              exact: true,
            })
            .click();
          if (mode === 'missing')
            await page
              .getByText(
                'These notes were not saved for offline use. Connect to the internet to load them.',
                { exact: true },
              )
              .waitFor();
          else
            await page
              .getByText('These study notes remain readable offline.', {
                exact: true,
              })
              .waitFor();
          await study(page)
            .getByRole('button', { name: 'Transcript', exact: true })
            .click();
          if (mode === 'local')
            await page
              .getByText('The saved transcript can be read without internet.', {
                exact: true,
              })
              .waitFor();
          else
            await page
              .getByText(
                'This transcript was not saved for offline use. Connect to the internet to load it.',
                { exact: true },
              )
              .waitFor();
        } finally {
          await context.close();
          await browser.close();
        }
      },
    );
  }
  await test(
    'downloaded study content refreshes automatically without a manual update action',
    { timeout: 90000 },
    async () => {
      const browser = await chromium.launch();
      const { context, page } = await setup(browser);
      try {
        await startDownload(page);
        await page
          .getByRole('button', { name: 'Downloaded', exact: true })
          .waitFor({ timeout: 60000 });
        await page.goto(origin + '/?view=downloads');
        await page
          .getByText('Transcript, Notes, Summaries saved offline', {
            exact: true,
          })
          .waitFor();
        await offline(context, page, true);
        await page.reload();
        await page
          .getByRole('heading', { name: 'No internet connection' })
          .waitFor();
        // All materials are already saved, but the transcript has since changed.
        const content = await page.evaluate(async () => {
          const cache = await caches.open('yutorah-study-v1');
          const path = '/api/transcript?id=900001';
          const saved = await (await cache.match(path)).json();
          saved.segments[0].text = 'Old saved transcript';
          await cache.put(path, Response.json(saved));
          const content = await new Promise((resolve, reject) => {
            const request = indexedDB.open('yutorah-downloads-v1');
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('shiurim', 'readwrite');
              const store = tx.objectStore('shiurim');
              const get = store.get(900001);
              let content;
              get.onsuccess = () => {
                const item = get.result;
                content = { ...item.content };
                item.content.checkedAt = Date.now() - 61 * 60_000;
                store.put(item);
              };
              tx.oncomplete = () => {
                db.close();
                resolve(content);
              };
              tx.onerror = () => reject(tx.error);
            };
            request.onerror = () => reject(request.error);
          });
          return content;
        });
        for (const kind of ['transcript', 'notes', 'summary', 'image'])
          assert.equal(content[kind], true, kind + ' is already saved');
        transcriptDelay = 2000;
        await offline(context, page, false);
        await waitForSavedData(page, async () => {
          const saved = await (
            await (
              await caches.open('yutorah-study-v1')
            ).match('/api/transcript?id=900001')
          ).json();
          return saved.segments[0].text !== 'Old saved transcript';
        });
        assert.equal(await page.locator('.toast.visible').count(), 0);
        await page.goto(origin + '/?shiur=' + shiur.id);
        await page
          .getByRole('button', { name: 'Downloaded', exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole('button', { name: 'Update offline content' })
            .count(),
          0,
        );
        await offline(context, page, true);
        assert.equal(
          await page.evaluate(async () => {
            const response = await (
              await caches.open('yutorah-study-v1')
            ).match('/api/transcript?id=900001');
            return (await response.json()).segments[0].text;
          }),
          transcript.segments[0].text,
        );
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );
  await test(
    'rebbei portraits are shared across downloads and existing downloads gain study content',
    { timeout: 90000 },
    async () => {
      const browser = await chromium.launch();
      const { context, page } = await setup(browser);
      try {
        await startDownload(page);
        await page
          .getByRole('button', { name: 'Downloaded', exact: true })
          .waitFor({ timeout: 60000 });
        const requests = portraitRequests;
        await startDownload(page, 900002);
        await page
          .getByRole('button', { name: 'Downloaded', exact: true })
          .waitFor({ timeout: 60000 });
        assert.equal(portraitRequests, requests);
        assert.equal(
          await page.evaluate(
            async () =>
              (await (await caches.open('yutorah-portraits-v1')).keys()).length,
          ),
          1,
        );
        // Recreate a download from the previous audio-only release.
        await page.evaluate(async () => {
          await caches.delete('yutorah-study-v1');
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('yutorah-downloads-v1');
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('shiurim', 'readwrite');
              const store = tx.objectStore('shiurim');
              const get = store.get(900001);
              get.onsuccess = () => {
                const item = get.result;
                delete item.content;
                store.put(item);
              };
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => reject(tx.error);
            };
            request.onerror = () => reject(request.error);
          });
        });
        await page.goto(origin + '/?view=downloads');
        await page
          .locator('.downloaded-shiur')
          .filter({ hasText: shiur.title })
          .getByText('Transcript, Notes, Summaries saved offline', {
            exact: true,
          })
          .waitFor();
        await waitForSavedData(page, async () =>
          (
            await Promise.all(
              ['transcript', 'study-notes', 'official-study'].map(
                async (kind) =>
                  Boolean(
                    await (
                      await caches.open('yutorah-study-v1')
                    ).match('/api/' + kind + '?id=900001'),
                  ),
              ),
            )
          ).every(Boolean),
        );
        await offline(context, page, true);
        await page.reload();
        await page
          .locator('.downloaded-shiur')
          .filter({ hasText: shiur.title })
          .getByRole('button', { name: 'Read transcript & notes', exact: true })
          .click();
        await page
          .getByText('These study notes remain readable offline.', {
            exact: true,
          })
          .waitFor({ timeout: 5000 });
        await study(page)
          .getByRole('button', { name: 'Transcript', exact: true })
          .click();
        await page
          .getByText('The saved transcript can be read without internet.', {
            exact: true,
          })
          .waitFor({ timeout: 5000 });
      } catch (error) {
        console.log(
          'Migration failure',
          await page.evaluate(async () => ({
            text: document.body.innerText,
            study: (await (await caches.open('yutorah-study-v1')).keys()).map(
              (key) => key.url,
            ),
          })),
        );
        throw error;
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );
  await test(
    'interrupted download is retryable and never appears available offline',
    { timeout: 90000 },
    async () => {
      const browser = await chromium.launch();
      const { context, page } = await setup(browser);
      downloadMode = 'reset';
      try {
        await startDownload(page);
        await page
          .getByRole('button', { name: 'Retry download', exact: true })
          .waitFor({ timeout: 60000 });
        assert.equal(
          await page
            .getByRole('button', { name: 'Downloaded', exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.evaluate(
            async () =>
              (await (await caches.open('yutorah-audio-v1')).keys()).length,
          ),
          0,
        );
        downloadMode = 'ok';
        await page
          .getByRole('button', { name: 'Retry download', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Downloaded', exact: true })
          .waitFor();
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );
  await test(
    'cancelling while study content is saving removes partial audio and study content',
    { timeout: 90000 },
    async () => {
      const browser = await chromium.launch();
      const { context, page } = await setup(browser);
      studyMode = 'blocked';
      try {
        await startDownload(page);
        await page
          .getByText('Saving image and study content…', { exact: true })
          .waitFor({ timeout: 60000 });
        await page
          .getByRole('button', { name: 'Cancel download', exact: true })
          .click();
        releaseStudy?.();
        await waitForSavedData(
          page,
          async () =>
            (await (await caches.open('yutorah-audio-v1')).keys()).length ===
              0 &&
            (await (await caches.open('yutorah-study-v1')).keys()).length === 0,
        );
        studyMode = 'official';
        await page
          .getByRole('button', { name: 'Download for offline', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Downloaded', exact: true })
          .waitFor();
      } finally {
        releaseStudy?.();
        await context.close();
        await browser.close();
      }
    },
  );
  await test(
    'missing cached audio is removed from Downloads rather than shown as playable',
    { timeout: 90000 },
    async () => {
      const browser = await chromium.launch();
      const { context, page } = await setup(browser);
      try {
        await startDownload(page);
        await page
          .getByRole('button', { name: 'Downloaded', exact: true })
          .waitFor({ timeout: 60000 });
        await page.evaluate(async () =>
          (await caches.open('yutorah-audio-v1')).delete(
            '/offline-audio/900001',
          ),
        );
        await context.setOffline(true);
        await page.reload();
        await page
          .getByRole('heading', { name: 'No downloaded shiurim yet' })
          .waitFor();
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );
  await test(
    'cancelling a running download leaves no file and allows downloading again',
    { timeout: 90000 },
    async () => {
      const browser = await chromium.launch();
      const { context, page } = await setup(browser);
      downloadMode = 'blocked';
      try {
        await startDownload(page);
        await page
          .locator('.download-inline-progress')
          .getByText('0%', { exact: true })
          .waitFor({ timeout: 60000 });
        await page
          .getByRole('button', { name: 'Cancel download', exact: true })
          .click();
        releaseDownload?.();
        await page
          .getByRole('button', { name: 'Download for offline', exact: true })
          .waitFor();
        assert.equal(
          await page.evaluate(
            async () =>
              (await (await caches.open('yutorah-audio-v1')).keys()).length,
          ),
          0,
        );
        downloadMode = 'ok';
        await page
          .getByRole('button', { name: 'Download for offline', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Downloaded', exact: true })
          .waitFor();
      } finally {
        releaseDownload?.();
        await context.close();
        await browser.close();
      }
    },
  );
  await test(
    'insufficient storage explains recovery and never marks the recording downloaded',
    { timeout: 90000 },
    async () => {
      const browser = await chromium.launch();
      const { context, page } = await setup(browser);
      await context.addInitScript(() =>
        Object.defineProperty(navigator.storage, 'estimate', {
          configurable: true,
          value: async () => ({ quota: 1, usage: 1 }),
        }),
      );
      try {
        await startDownload(page);
        await page
          .getByText(
            'Not enough storage. Remove a download or free space on your device, then try again.',
            { exact: true },
          )
          .waitFor({ timeout: 60000 });
        assert.equal(
          await page
            .getByRole('button', { name: 'Downloaded', exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.evaluate(
            async () =>
              (await (await caches.open('yutorah-audio-v1')).keys()).length,
          ),
          0,
        );
        await page.evaluate(() => {
          delete navigator.storage.estimate;
        });
        await page
          .getByRole('button', { name: 'Retry download', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Downloaded', exact: true })
          .waitFor();
      } finally {
        await context.close();
        await browser.close();
      }
    },
  );
} finally {
  portraitServer.closeAllConnections();
  await new Promise((resolve) => portraitServer.close(resolve));
  fixtures.closeAllConnections();
  await new Promise((resolve) => fixtures.close(resolve));
  server?.kill();
  await rm(state, { recursive: true, force: true });
}
