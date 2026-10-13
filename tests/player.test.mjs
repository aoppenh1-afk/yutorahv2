import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const externalOrigin = process.env.TEST_ORIGIN;
const origin = externalOrigin || 'http://127.0.0.1:3015';
const state = externalOrigin
  ? null
  : await mkdtemp(join(tmpdir(), 'yutorah-player-'));
const server = externalOrigin
  ? null
  : spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '--config',
        'dist/server/wrangler.json',
        '--port',
        '3015',
        '--persist-to',
        state,
      ],
      { stdio: 'ignore' },
    );
let browser;
const cssCoverage = new Map();
try {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(origin, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) break;
    } catch {}
    if (
      attempt >= 30 ||
      (server?.exitCode !== null && server?.exitCode !== undefined)
    )
      throw new Error(
        'Build the website with npm run build before running player tests.',
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {},
  );
} catch (error) {
  server?.kill();
  if (state) await rm(state, { recursive: true, force: true });
  throw error;
}

// A real, seekable local recording keeps playback independent of the upstream CDN.
const samples = 8000 * 120;
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
  title: 'Player regression recording',
  teacher: 'Test teacher',
  teacherId: 1,
  image: '',
  audio: `${origin}/player-test.wav`,
  url: origin,
  date: '2026-10-01',
  duration: 120,
  topics: [],
  category: '',
  language: 'EN',
  seriesId: 0,
  series: '',
  description: '',
  format: 'mp3',
  materials: [],
};
async function openPlayer(viewport, stalled = false, options = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: options.pixelRatio || 1,
  });
  const recording = {
    ...shiur,
    title: options.title || shiur.title,
    image: options.image || '',
    teacherId: options.teacherId || shiur.teacherId,
    teacher: options.teacher || shiur.teacher,
  };
  await context.addInitScript(
    ({ s, initialLibrary }) => {
      if (!localStorage.getItem('yutorah-learning-v1'))
        localStorage.setItem(
          'yutorah-learning-v1',
          JSON.stringify({
            last: s,
            history: [{ shiur: s, seconds: 42, duration: 120 }],
            queue: [{ ...s, id: 900002 }],
            ...initialLibrary,
          }),
        );
    },
    { s: recording, initialLibrary: options.initialLibrary },
  );
  await context.route('**/api/home', (route) =>
    route.fulfill({
      json: {
        featured: [],
        recent: [],
        daily: [],
        series: [],
        total: 0,
        hebrewDate: '',
        daf: '',
        nach: '',
        mishna: '',
        fetchedAt: new Date().toISOString(),
        ...options.home,
      },
    }),
  );
  await context.route('**/api/directory', (route) =>
    route.fulfill({ json: { teachers: [], series: [], topics: [] } }),
  );
  await context.route('**/api/related?*', (route) =>
    route.fulfill({ json: { items: [], partial: false } }),
  );
  await context.route('**/api/feed?*', (route) =>
    route.fulfill({ json: { items: [], partial: false } }),
  );
  await context.route('**/api/autocomplete?*', (route) =>
    route.fulfill({ json: { suggestions: [] } }),
  );
  await context.route('**/api/shiur?id=900001', (route) =>
    route.fulfill({ json: recording }),
  );
  await context.route(
    'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/player-fixture*.jpg',
    (route) => {
      const original = route.request().url().includes('_lp.jpg');
      if (original && options.missingOriginal)
        return route.fulfill({ status: 404, body: '' });
      const width = original ? 240 : 50;
      const height = original ? 280 : 50;
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#325a89"/></svg>`,
      });
    },
  );
  await context.route('**/player-test.wav', async (route) => {
    if (stalled) await new Promise((resolve) => setTimeout(resolve, 1500));
    const range = route
      .request()
      .headers()
      .range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(Number(range[2]), wav.length - 1)
      : wav.length - 1;
    await route
      .fulfill({
        status: range ? 206 : 200,
        contentType: 'audio/wav',
        body: wav.subarray(start, end + 1),
        headers: {
          'Accept-Ranges': 'bytes',
          ...(range
            ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` }
            : {}),
        },
      })
      .catch(() => {});
  });
  const page = await context.newPage();
  if (process.env.PERFORMANCE_CSS_REPORT) {
    const cdp = await context.newCDPSession(page);
    const sheets = new Map();
    cdp.on('CSS.styleSheetAdded', ({ header }) => {
      if (header.sourceURL.includes('/_next/static/css/'))
        sheets.set(header.styleSheetId, {
          ...header,
          // A stylesheet may disappear during navigation before fixture cleanup.
          text: cdp
            .send('CSS.getStyleSheetText', {
              styleSheetId: header.styleSheetId,
            })
            .then(({ text }) => text)
            .catch(() => null),
        });
    });
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('CSS.startRuleUsageTracking');
    const close = context.close.bind(context);
    context.close = async () => {
      try {
        const { ruleUsage } = await cdp
          .send('CSS.stopRuleUsageTracking')
          .catch(() => ({ ruleUsage: [] }));
        for (const [id, sheet] of sheets) {
          const text = await sheet.text;
          if (text === null) continue;
          const key = new URL(sheet.sourceURL).pathname;
          const entry = cssCoverage.get(key) ?? {
            characters: text.length,
            ranges: new Map(),
          };
          for (const rule of ruleUsage.filter(
            (rule) => rule.styleSheetId === id && rule.used,
          ))
            entry.ranges.set(`${rule.startOffset}:${rule.endOffset}`, [
              rule.startOffset,
              rule.endOffset,
            ]);
          cssCoverage.set(key, entry);
        }
      } finally {
        await close();
      }
    };
  }
  await options.onPage?.(page, context);
  await page.goto(new URL(options.path || '/', origin).href, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .getByRole('region', { name: 'Audio player', exact: true })
    .waitFor();
  if (!stalled) {
    await page.waitForFunction(
      () => document.querySelector('audio')?.readyState >= 2,
    );
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('audio').paused);
  }
  return { context, page };
}
async function assertInViewport(locator, viewport) {
  const rect = await locator.boundingBox();
  assert.ok(rect, 'control has visible bounds');
  assert.ok(rect.x >= -1 && rect.y >= -1, JSON.stringify(rect));
  assert.ok(rect.x + rect.width <= viewport.width + 1, JSON.stringify(rect));
  assert.ok(rect.y + rect.height <= viewport.height + 1, JSON.stringify(rect));
}
async function closeAndVerify(page, minSeconds = 42) {
  await page.getByRole('button', { name: 'Close player', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.player'));
  // A late media event must not advance the queue or restore the closed player.
  const result = await page.evaluate(() => {
    const audio = document.querySelector('audio');
    audio.dispatchEvent(new Event('ended'));
    return {
      paused: audio.paused,
      src: audio.getAttribute('src'),
      library: JSON.parse(localStorage.getItem('yutorah-learning-v1')),
      metadata: navigator.mediaSession?.metadata,
    };
  });
  assert.equal(result.paused, true);
  assert.equal(result.src, null);
  assert.equal(result.library.last, null);
  assert.ok(
    result.library.history[0].seconds >= minSeconds,
    JSON.stringify(result.library.history[0]),
  );
  assert.equal(result.library.queue.length, 1);
  assert.equal(result.metadata, null);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  assert.equal(
    await page
      .getByRole('region', { name: 'Audio player', exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.evaluate(() => document.querySelector('audio').paused),
    true,
  );
}

void test('player controls stop playback and the phone dialog stays inside the built viewport', async (t) => {
  try {
    await t.test(
      'active mobile shiur keeps its title and play button colors',
      async () => {
        const { context, page } = await openPlayer(
          { width: 390, height: 844 },
          false,
          {
            home: { featured: [shiur], recent: [shiur] },
          },
        );
        try {
          const card = page
            .locator('.mobile-recording-card')
            .filter({ hasText: shiur.title })
            .first();
          await card.waitFor();
          await page.waitForFunction(() =>
            [...document.querySelectorAll('.mobile-recording-card')].some(
              (el) => el.classList.contains('is-playing'),
            ),
          );
          const colors = await card.evaluate((el) => ({
            title: getComputedStyle(el.querySelector('h3 button > span')).color,
            button: getComputedStyle(
              el.querySelector('.recording-portrait > span'),
            ).backgroundColor,
          }));
          await page
            .getByRole('button', { name: 'Pause', exact: true })
            .click();
          await page.waitForFunction(
            () => document.querySelector('audio').paused,
          );
          await page.waitForFunction(
            () => !document.querySelector('.mobile-recording-card.is-playing'),
          );
          const paused = await card.evaluate((el) => ({
            title: getComputedStyle(el.querySelector('h3 button > span')).color,
            button: getComputedStyle(
              el.querySelector('.recording-portrait > span'),
            ).backgroundColor,
          }));
          assert.deepEqual(colors, paused);
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'mobile featured Play opens the full audio player',
      async () => {
        const { context, page } = await openPlayer(
          { width: 390, height: 844 },
          false,
          {
            home: {
              featured: [{ ...shiur, teacher: 'Rabbi Test teacher' }],
              recent: [shiur],
            },
          },
        );
        try {
          await page
            .getByRole('button', { name: 'Pause', exact: true })
            .click();
          await page.locator('.m-hero-play[aria-label^="Play "]').waitFor();
          await page.locator('.m-hero-play').click();
          await page.waitForFunction(
            () => !document.querySelector('audio').paused,
          );
          await page.locator('.mobile-now-playing').waitFor();
          assert.equal(
            await page.locator('.mobile-now-playing').isVisible(),
            true,
          );
          await page
            .getByRole('button', { name: 'Collapse player controls' })
            .click();
          await page
            .locator('.mobile-now-playing')
            .waitFor({ state: 'hidden' });
          assert.equal(
            await page.locator('.mobile-now-playing').isVisible(),
            false,
          );
          await page
            .getByRole('button', { name: 'Close player', exact: true })
            .click();
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.locator('.m-hero-play[aria-label^="Play "]').waitFor();
          assert.equal(await page.locator('.player').count(), 0);
          await page.locator('.m-hero-play').click();
          await page.locator('.mobile-now-playing').waitFor();
          await page.waitForFunction(
            () => !document.querySelector('audio').paused,
          );
        } finally {
          await context.close();
        }
      },
    );
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await t.test(
        `profile settings persist teacher alerts and default speed at ${viewport.width}px`,
        async () => {
          const { context, page } = await openPlayer(viewport, false, {
            initialLibrary: {
              following: [{ kind: 'teacher', id: 1, name: 'Test teacher' }],
              defaultSpeed: 1.25,
              speed: 1,
            },
          });
          try {
            if (viewport.width >= 768) {
              assert.equal(
                await page.locator('.header-account-button').isVisible(),
                false,
              );
              await assertInViewport(page.locator('.sidebar-signin'), viewport);
              await page.locator('.sidebar-settings-link').click();
            } else
              await page
                .getByRole('button', { name: 'Profile settings', exact: true })
                .click();
            const dialog = page.getByRole('dialog', {
              name: 'Settings',
              exact: true,
            });
            await assertInViewport(dialog, viewport);
            await dialog
              .getByRole('combobox', { name: 'Default speed', exact: true })
              .click();
            await page
              .locator('.settings-speed-menu')
              .getByRole('option', { name: '1.5×', exact: true })
              .click();
            await page.waitForFunction(
              () => document.querySelector('audio').playbackRate === 1.5,
            );
            await dialog
              .getByRole('switch', {
                name: 'New shiur alerts from Test teacher',
                exact: true,
              })
              .click();
            const stored = await page.evaluate(() =>
              JSON.parse(localStorage.getItem('yutorah-learning-v1')),
            );
            assert.equal(stored.defaultSpeed, 1.5);
            assert.equal(stored.following.length, 1);
            assert.equal(stored.following[0].notificationsEnabled, false);
            await dialog
              .getByRole('button', { name: 'Close', exact: true })
              .click();
            // A temporary player override must not replace the saved default.
            await page
              .getByRole('button', {
                name:
                  viewport.width >= 768
                    ? 'Open fullscreen player'
                    : 'Expand player controls',
                exact: true,
              })
              .click();
            const playerDialog = page.locator('.mobile-now-playing');
            await playerDialog
              .getByRole('button', { name: 'Playback speed', exact: true })
              .click();
            await page
              .locator('.playback-speed-popup')
              .getByRole('slider', { name: 'Playback speed' })
              .press('End');
            await page.waitForFunction(
              () => document.querySelector('audio').playbackRate === 3,
            );
            await page.keyboard.press('Escape');
            await playerDialog
              .getByRole('button', { name: 'Play next in queue', exact: true })
              .click();
            await page.waitForFunction(
              () => document.querySelector('audio').playbackRate === 1.5,
            );
            await page.keyboard.press('Escape');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(
              () =>
                JSON.parse(localStorage.getItem('yutorah-learning-v1'))
                  .following[0].notificationsEnabled === false,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  JSON.parse(localStorage.getItem('yutorah-learning-v1'))
                    .defaultSpeed,
              ),
              1.5,
            );
          } finally {
            await context.close();
          }
        },
      );
    }
    await t.test(
      'a direct Trending visit displays saved recordings before a blocked refresh completes',
      async () => {
        let release;
        const blocked = new Promise((resolve) => {
          release = resolve;
        });
        let savedRequests = 0;
        let refreshRequests = 0;
        let refreshed = false;
        const freshTitle = 'Refreshed trending recording';
        const { context, page } = await openPlayer(
          { width: 1280, height: 800 },
          false,
          {
            path: '/?view=trending',
            onPage: async (_page, context) => {
              await context.route('**/api/discover?*', async (route) => {
                const params = new URL(route.request().url()).searchParams;
                const saved = params.get('cached') === '1';
                if (saved) savedRequests++;
                else {
                  refreshRequests++;
                  await blocked;
                  refreshed = true;
                }
                await route
                  .fulfill({
                    json: {
                      trending: [
                        { ...shiur, title: saved ? shiur.title : freshTitle },
                      ],
                      sampled: saved ? 30 : 60,
                      total: 60,
                      libraryTotal: 60,
                      partial: saved,
                      stale: saved,
                      period: params.get('period'),
                      minutes: Number(params.get('minutes')),
                      fetchedAt: new Date().toISOString(),
                      before: new Date().toISOString(),
                    },
                  })
                  .catch(() => {});
              });
            },
          },
        );
        try {
          await page
            .locator('.trending-list')
            .getByText(shiur.title, { exact: true })
            .waitFor();
          assert.equal(
            refreshed,
            false,
            'Saved recordings must render while the refresh is blocked',
          );
          assert.equal(savedRequests, 1);
          assert.equal(refreshRequests, 1);
          release();
          await page
            .locator('.trending-list')
            .getByText(freshTitle, { exact: true })
            .waitFor();
          assert.equal(
            await page
              .locator('.trending-list')
              .getByText(shiur.title, { exact: true })
              .count(),
            0,
          );
        } finally {
          release();
          await context.close();
        }
      },
    );
    await t.test(
      'Trending retries stale charts and keeps polling completed charts during rebuilds',
      async () => {
        let discoveryRequests = 0;
        let savedRequests = 0;
        const refreshedTitle = 'Refreshed polling chart';
        const { context, page } = await openPlayer(
          { width: 1280, height: 800 },
          false,
          {
            onPage: async (page, context) => {
              await page.clock.install();
              await context.route('**/api/discover?*', (route) => {
                const selected = new URL(route.request().url()).searchParams;
                const saved = selected.get('cached') === '1';
                if (saved) savedRequests++;
                else discoveryRequests++;
                return route.fulfill({
                  json: {
                    trending: [
                      { ...shiur, title: saved ? shiur.title : refreshedTitle },
                    ],
                    sampled: 30,
                    total: 30,
                    libraryTotal: 30,
                    partial: false,
                    stale: saved || discoveryRequests === 1,
                    refreshing: !saved && discoveryRequests === 2,
                    period: selected.get('period'),
                    minutes: Number(selected.get('minutes')),
                    fetchedAt: new Date().toISOString(),
                    before: new Date().toISOString(),
                  },
                });
              });
            },
          },
        );
        try {
          await page
            .locator('.discovery-tabs')
            .getByRole('button', { name: 'Trending', exact: true })
            .click();
          await page
            .locator('.trending-list')
            .getByText(refreshedTitle, { exact: true })
            .waitFor();
          assert.equal(discoveryRequests, 1);
          assert.equal(savedRequests, 1);
          await page.clock.runFor(30100);
          await page
            .getByText('Updating rankings. Showing the last saved chart.', {
              exact: true,
            })
            .waitFor();
          assert.equal(
            discoveryRequests,
            2,
            'A stale response must not stop indexing',
          );
          await page.clock.runFor(3600);
          await page.waitForFunction(
            () =>
              !document.body.textContent.includes(
                'Updating rankings. Showing the last saved chart.',
              ),
          );
          assert.equal(
            discoveryRequests,
            3,
            'A completed chart shown during a rebuild must keep polling',
          );
          await page.clock.runFor(10000);
          assert.equal(
            discoveryRequests,
            3,
            'Completed fresh charts must stop polling',
          );
          assert.equal(savedRequests, 1, 'Polling reuses the displayed chart');
        } finally {
          await context.close();
        }
      },
    );
    for (const { height, sectionGap = 0 } of [
      { height: 800 },
      { height: 2000 },
      { height: 2000, sectionGap: 2600 },
    ]) {
      await t.test(
        `Home shows saved Trending and defers scans until scrolling near its section at ${height}px height${sectionGap ? ' with extra content above Trending' : ''}`,
        async () => {
          let discoveryRequests = 0;
          let savedRequests = 0;
          const savedTitle = 'Saved Home ranking';
          const { context, page } = await openPlayer(
            { width: 1280, height },
            false,
            {
              initialLibrary: { history: [] },
              onPage: async (_page, context) => {
                await context.route('**/api/discover?*', (route) => {
                  const saved =
                    new URL(route.request().url()).searchParams.get(
                      'cached',
                    ) === '1';
                  if (saved) savedRequests++;
                  else discoveryRequests++;
                  return route.fulfill({
                    json: {
                      trending: [
                        { ...shiur, title: saved ? savedTitle : shiur.title },
                      ],
                      sampled: 1,
                      total: 1,
                      partial: false,
                      stale: saved,
                      period: 'week',
                      minutes: 0,
                      fetchedAt: new Date().toISOString(),
                    },
                  });
                });
              },
            },
          );
          try {
            const section = page.locator('.trending-section');
            if (sectionGap) {
              // Keep Trending below even a tall viewport to cover layout variation.
              await page.addStyleTag({
                content: `.trending-section { margin-top: ${sectionGap}px; }`,
              });
            }
            await section.getByText(savedTitle, { exact: true }).waitFor();
            await page.waitForTimeout(100);
            assert.equal(savedRequests, 1, 'Home reads the saved chart once');
            assert.equal(discoveryRequests, 0, 'initial Home defers scanning');
            await page.evaluate(() => window.scrollTo(0, 1));
            if (height === 800 || sectionGap) {
              await page.waitForTimeout(100);
              assert.equal(
                discoveryRequests,
                0,
                'scrolling far from Trending still defers scanning',
              );
            }
            await section.scrollIntoViewIfNeeded();
            await section.getByText(shiur.title, { exact: true }).waitFor();
            assert.equal(discoveryRequests, 1);
            await page.evaluate(() => window.scrollBy(0, 10));
            await page.waitForTimeout(100);
            assert.equal(
              discoveryRequests,
              1,
              'further scrolling reuses the chart',
            );
            assert.equal(savedRequests, 1, 'scanning reuses the saved chart');
          } finally {
            await context.close();
          }
        },
      );
    }
    for (const follows of [0, 10, 100]) {
      await t.test(
        `Home bounds initial requests for ${follows} follows and Following can load every source`,
        async () => {
          const requests = [];
          const { context, page } = await openPlayer(
            { width: 1280, height: 800 },
            false,
            {
              initialLibrary: {
                following: Array.from({ length: follows }, (_, i) => ({
                  kind: 'teacher',
                  id: i + 1,
                  name: 'Teacher ' + (i + 1),
                })),
                history: [],
              },
              onPage: async (page, context) => {
                page.on('request', (request) => requests.push(request.url()));
                await context.route('**/api/discover?*', (route) =>
                  route.fulfill({
                    json: {
                      trending: [shiur],
                      sampled: 1,
                      total: 1,
                      partial: false,
                      stale: true,
                      period: 'week',
                      minutes: 0,
                      fetchedAt: new Date().toISOString(),
                    },
                  }),
                );
              },
            },
          );
          try {
            await page
              .getByRole('heading', { name: 'The Torah library.', exact: true })
              .waitFor();
            await page.waitForTimeout(100);
            const feeds = () =>
              requests.filter((url) => url.includes('/api/feed?'));
            assert.ok(feeds().length <= 1);
            for (const url of feeds())
              assert.ok(
                [...new URL(url).searchParams.values()]
                  .join(',')
                  .split(',')
                  .filter(Boolean).length <= 8,
              );
            const discoveryRequests = requests.filter((url) =>
              url.includes('/api/discover?'),
            );
            assert.equal(discoveryRequests.length, 1);
            assert.ok(
              discoveryRequests.every(
                (url) => new URL(url).searchParams.get('cached') === '1',
              ),
              'initial Home only reads saved rankings without starting a scan',
            );
            assert.equal(
              requests.filter((url) =>
                /\/(transcript-reader|react-markdown|sources-panel|advanced-search|secondary-screens)-[^/]+\.js/.test(
                  url,
                ),
              ).length,
              0,
            );
            if (follows > 8) {
              await page
                .getByLabel('Discovery views')
                .getByRole('button', { name: 'Following', exact: true })
                .click();
              while (
                await page
                  .getByRole('button', { name: /^Load more followed sources/ })
                  .count()
              ) {
                await page
                  .getByRole('button', { name: /^Load more followed sources/ })
                  .click();
                await page.waitForTimeout(30);
              }
              await page.waitForFunction(
                () => !document.querySelector('.feed-loading'),
              );
              await page.waitForTimeout(100);
              const ids = new Set(
                feeds().flatMap(
                  (url) =>
                    new URL(url).searchParams
                      .get('teacher')
                      ?.split(',')
                      .filter(Boolean) ?? [],
                ),
              );
              assert.equal(ids.size, follows);
              assert.equal(
                feeds().length,
                Math.ceil(follows / 8),
                'ready batches are reused when Following grows',
              );
            }
          } finally {
            await context.close();
          }
        },
      );
    }
    await t.test(
      'a slow homepage leaves the shell and saved library usable',
      async () => {
        let release;
        const held = new Promise((resolve) => {
          release = resolve;
        });
        const start = Date.now();
        const { context, page } = await openPlayer(
          { width: 1280, height: 800 },
          false,
          {
            initialLibrary: { saved: [shiur] },
            onPage: async (_page, context) => {
              await context.route('**/api/home', async (route) => {
                await held;
                await route
                  .fulfill({
                    status: 503,
                    json: { error: 'Fixture unavailable' },
                  })
                  .catch(() => {});
              });
            },
          },
        );
        try {
          assert.ok(
            Date.now() - start < 5000,
            'player and shell do not await the blocked homepage',
          );
          await page
            .locator('.nav-button')
            .filter({ hasText: 'Saved shiurim' })
            .click();
          await page
            .getByRole('heading', { name: '1 saved shiur', exact: true })
            .waitFor();
          assert.equal(
            await page.locator('audio').evaluate((audio) => audio.paused),
            false,
          );
        } finally {
          release();
          await context.close();
        }
      },
    );
    await t.test(
      'failed secondary chunks leave navigation and playback usable',
      async () => {
        const { context, page } = await openPlayer(
          { width: 1280, height: 800 },
          false,
          {
            onPage: async (_page, context) => {
              await context.route('**/secondary-screens-*.js', (route) =>
                route.abort(),
              );
            },
          },
        );
        try {
          await page
            .locator('.nav-button')
            .filter({ hasText: 'Saved shiurim' })
            .click();
          await page
            .getByText('This screen could not load.', { exact: false })
            .waitFor();
          assert.equal(
            await page.locator('audio').evaluate((audio) => audio.paused),
            false,
          );
          await page
            .locator('.nav-button')
            .filter({ hasText: 'Search' })
            .click();
          await page.locator('#main-search').waitFor();
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      '1,000 loaded results and 5,000 transcript segments stay bounded during 60 seconds of clock updates',
      async () => {
        const items = Array.from({ length: 1000 }, (_, i) => ({
          ...shiur,
          id: 10000 + i,
          title: 'Large fixture ' + i,
        }));
        const segments = Array.from({ length: 5000 }, (_, i) => ({
          startMs: i * 24,
          endMs: (i + 1) * 24,
          text: 'Timed segment ' + i,
          speaker: null,
        }));
        const { context, page } = await openPlayer(
          { width: 1280, height: 800 },
          false,
          {
            initialLibrary: {
              saved: items,
              queue: items.slice(0, 100),
              history: [
                { shiur, seconds: 42, duration: 120 },
                ...items.slice(0, 199).map((recording) => ({
                  shiur: recording,
                  seconds: 12,
                  duration: 120,
                })),
              ],
              playlists: Array.from({ length: 10 }, (_, i) => ({
                id: String(i),
                name: 'Large playlist ' + i,
                items: items.slice(i * 100, (i + 1) * 100),
              })),
            },
            onPage: async (_page, context) => {
              await context.addInitScript(() => {
                sessionStorage.setItem('yutorah-performance-sample', '1');
                window.libraryWrites = 0;
                window.mobileListeners = 0;
                // oxlint-disable-next-line typescript/unbound-method -- The wrapper passes its original receiver with .call.
                const setItem = Storage.prototype.setItem;
                Storage.prototype.setItem = function (key, value) {
                  if (key === 'yutorah-learning-v1') window.libraryWrites++;
                  return setItem.call(this, key, value);
                };
                // oxlint-disable-next-line typescript/unbound-method -- The wrapper passes its original receiver with .call.
                const add = MediaQueryList.prototype.addEventListener;
                // oxlint-disable-next-line typescript/unbound-method -- The wrapper passes its original receiver with .call.
                const remove = MediaQueryList.prototype.removeEventListener;
                MediaQueryList.prototype.addEventListener = function (
                  type,
                  ...args
                ) {
                  if (type === 'change' && /max-width.*767px/.test(this.media))
                    window.mobileListeners++;
                  return add.call(this, type, ...args);
                };
                MediaQueryList.prototype.removeEventListener = function (
                  type,
                  ...args
                ) {
                  if (type === 'change' && /max-width.*767px/.test(this.media))
                    window.mobileListeners--;
                  return remove.call(this, type, ...args);
                };
              });
              await context.route('**/api/search?*', (route) =>
                route.fulfill({
                  json: {
                    items,
                    total: 1000,
                    scanned: 1000,
                    sourceTotal: 1000,
                    complete: true,
                    nextPage: null,
                    filtered: false,
                    plan: {
                      term: 'fixture',
                      original: 'fixture',
                      max: 0,
                      language: '',
                      format: '',
                      teacherId: 0,
                      teacherName: '',
                      seriesId: 0,
                      seriesName: '',
                      topicId: 0,
                      labels: [],
                      sort: 'relevance',
                    },
                    facets: { teachers: [], topics: [], series: [] },
                  },
                }),
              );
              await context.route('**/api/transcript?*', (route) =>
                route.fulfill({
                  json: {
                    id: '900001',
                    transcriptId: 'fixture-large',
                    version: 'a'.repeat(64),
                    title: shiur.title,
                    teacher: shiur.teacher,
                    durationMs: 120000,
                    createdAt: '2026-10-05T00:00:00Z',
                    segments,
                    notes: {
                      status: 'completed',
                      markdown: '# Complete notes',
                    },
                  },
                }),
              );
            },
          },
        );
        try {
          await page
            .locator('.nav-button')
            .filter({ hasText: 'Search' })
            .click();
          await page.locator('#main-search').fill('fixture');
          await page.locator('#main-search').press('Enter');
          await page.locator('.shiur-row').first().waitFor();
          assert.equal(await page.locator('.shiur-row').count(), 60);
          assert.equal(await page.evaluate(() => window.mobileListeners), 1);
          await page
            .getByRole('navigation', { name: 'List pages' })
            .getByRole('button', { name: 'Next', exact: true })
            .click();
          await page.getByText('61–120 of 1,000', { exact: true }).waitFor();
          assert.equal(await page.locator('.shiur-row').count(), 60);
          await page
            .getByRole('button', { name: 'Open shiur details and notes' })
            .click();
          await page.locator('.study-segment').first().waitFor();
          assert.equal(await page.locator('.study-segment').count(), 100);
          assert.equal(
            await page
              .getByRole('link', { name: 'Open complete text' })
              .count(),
            1,
          );
          await page
            .getByRole('navigation', { name: 'Transcript pages' })
            .getByRole('button', { name: 'Next', exact: true })
            .click();
          assert.equal(
            await page.evaluate(() => document.activeElement.className),
            'study-transcript',
          );
          const first = Number(
            (
              await page.locator('.study-segment p').first().textContent()
            ).match(/\d+/)[0],
          );
          await page.locator('.study-time').first().click();
          await page.waitForFunction(
            (seconds) =>
              Math.abs(document.querySelector('audio').currentTime - seconds) <
              1,
            first * 0.024,
          );
          await page.evaluate(() => {
            window.clockSeconds = document.querySelector('audio').currentTime;
            Object.defineProperty(
              document.querySelector('audio'),
              'currentTime',
              {
                configurable: true,
                get: () => window.clockSeconds,
                set: (seconds) => {
                  window.clockSeconds = seconds;
                },
              },
            );
            Object.defineProperty(document, 'hidden', {
              configurable: true,
              get: () => window.performanceHidden ?? false,
            });
          });
          const report = async () => {
            const request = page.waitForRequest('**/api/performance');
            await page.evaluate(() => {
              window.performanceHidden = true;
              document.dispatchEvent(new Event('visibilitychange'));
              window.performanceHidden = false;
              document.dispatchEvent(new Event('visibilitychange'));
            });
            return (await request).postDataJSON().metrics;
          };
          const before = await report();
          assert.ok(
            before.viewCommits > 0,
            'the sampled application commit counter is enabled',
          );
          await page.clock.install();
          for (let i = 0; i < 60; i++) {
            await page.evaluate((i) => {
              window.clockSeconds = 10 + i;
              document
                .querySelector('audio')
                .dispatchEvent(new Event('timeupdate'));
            }, i);
            await page.clock.runFor(1000);
          }
          const after = await report();
          assert.ok(
            after.viewCommits - before.viewCommits <= 4,
            JSON.stringify({ before, after }),
          );
          assert.ok(
            after.libraryWrites - before.libraryWrites <= 4,
            JSON.stringify({ before, after }),
          );
          console.log(
            JSON.stringify({
              event: 'large_playback_fixture',
              clockUpdates: 60,
              loadedResults: 1000,
              transcriptSegments: 5000,
              visibleResults: 60,
              visibleSegments: 100,
              viewCommits: after.viewCommits - before.viewCommits,
              libraryWrites: after.libraryWrites - before.libraryWrites,
            }),
          );
          assert.equal(
            await page.locator('audio').evaluate((audio) => audio.paused),
            false,
          );
          assert.equal(await page.locator('.study-segment').count(), 100);
          await page
            .locator('.detail-sheet')
            .getByRole('button', { name: 'Close', exact: true })
            .click();
          await page
            .getByRole('button', { name: 'Pause', exact: true })
            .click();
          const stored = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('yutorah-learning-v1')),
          );
          assert.equal(stored.version, 2);
          assert.ok(
            stored.history.find((progress) => progress.shiurId === 900001)
              .seconds >= 68,
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'cross-tab edits preserve buffered progress, legacy timestamps, and in-memory edits when storage fails',
      async () => {
        const { context, page } = await openPlayer({
          width: 1280,
          height: 800,
        });
        const remote = { ...shiur, id: 900003, title: 'Saved in another tab' };
        try {
          const other = await context.newPage();
          await other.goto(origin, { waitUntil: 'domcontentloaded' });
          await other
            .getByRole('region', { name: 'Audio player', exact: true })
            .waitFor();
          await page.waitForTimeout(5100);
          await page.evaluate(() => {
            Object.defineProperty(
              document.querySelector('audio'),
              'currentTime',
              {
                configurable: true,
                get: () => 66,
              },
            );
            document
              .querySelector('audio')
              .dispatchEvent(new Event('timeupdate'));
          });
          // Simulate a still-open v1 tab: its membership edit has no progress timestamp.
          await other.evaluate(
            ({ recording, remote }) => {
              localStorage.setItem(
                'yutorah-learning-v1',
                JSON.stringify({
                  saved: [remote],
                  history: [{ shiur: recording, seconds: 1, duration: 120 }],
                  last: recording,
                }),
              );
            },
            { recording: shiur, remote },
          );
          await page
            .getByRole('button', { name: 'Open saved shiurim' })
            .click();
          await page
            .locator('.shiur-row')
            .getByRole('button', { name: remote.title, exact: true })
            .waitFor();
          await page
            .getByRole('button', { name: 'Pause', exact: true })
            .click();
          const stored = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('yutorah-learning-v1')),
          );
          assert.equal(stored.version, 2);
          assert.deepEqual(stored.saved, [remote.id]);
          assert.equal(
            stored.history.find((progress) => progress.shiurId === shiur.id)
              .seconds,
            66,
          );
          await page.evaluate(() => {
            // oxlint-disable-next-line typescript/unbound-method -- The wrapper passes its original receiver with .call.
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
              if (key === 'yutorah-learning-v1')
                throw new Error('Fixture storage quota');
              return setItem.call(this, key, value);
            };
          });
          await page
            .getByRole('button', { name: 'Save playing shiur', exact: true })
            .click();
          await page.waitForFunction(
            () => document.querySelectorAll('.shiur-row').length === 2,
          );
          await page
            .getByText(
              'Your browser could not save changes. Free some device storage and try again.',
            )
            .waitFor();
          assert.equal(
            await page.locator('audio').evaluate((audio) => audio.paused),
            true,
          );
          assert.deepEqual(
            await page.evaluate(
              () =>
                JSON.parse(localStorage.getItem('yutorah-learning-v1')).saved,
            ),
            [remote.id],
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'a shared shiur link opens with one detail request',
      async () => {
        const { context, page } = await openPlayer({
          width: 1280,
          height: 800,
        });
        let details = 0;
        try {
          await context.route('**/api/shiur?id=900001', (route) => {
            details++;
            return route.fulfill({ json: shiur });
          });
          await page.goto(origin + '/?shiur=900001&t=42', {
            waitUntil: 'domcontentloaded',
          });
          await page
            .getByRole('dialog', { name: 'Shiur details', exact: true })
            .waitFor();
          await page
            .getByRole('region', {
              name: 'Transcript, notes, and sources',
            })
            .waitFor();
          assert.equal(details, 1);
        } finally {
          await context.close();
        }
      },
    );
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 667, height: 375 },
      { width: 768, height: 844 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const { context, page } = await openPlayer(viewport);
        try {
          if (viewport.width >= 768) {
            for (const name of ['Rewind 15 seconds', 'Forward 15 seconds']) {
              const alignment = await page
                .getByRole('button', { name })
                .evaluate((button) => {
                  const icon = button
                    .querySelector('svg')
                    .getBoundingClientRect();
                  const label = button
                    .querySelector('span')
                    .getBoundingClientRect();
                  return {
                    contained:
                      label.left >= icon.left &&
                      label.right <= icon.right &&
                      label.top >= icon.top &&
                      label.bottom <= icon.bottom,
                    centerOffset: Math.abs(
                      label.left + label.width / 2 - icon.left - icon.width / 2,
                    ),
                  };
                });
              assert.ok(
                alignment.contained,
                `${name}: 15 fits inside the arrow icon`,
              );
              assert.ok(
                alignment.centerOffset < 1,
                `${name}: 15 is horizontally centered`,
              );
            }
          }
          await assertInViewport(
            page.getByRole('button', { name: 'Close player', exact: true }),
            viewport,
          );
          if (viewport.width < 768) {
            await page
              .getByRole('button', { name: 'Expand player controls' })
              .click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor();
            await assertInViewport(dialog, viewport);
            await assertInViewport(
              dialog.getByRole('button', { name: 'Close player' }),
              viewport,
            );
            assert.equal(
              await dialog.evaluate((el) =>
                Math.round(el.getBoundingClientRect().width),
              ),
              viewport.width,
            );
            await page
              .getByRole('button', { name: 'Collapse player controls' })
              .click();
            await page.waitForFunction(
              () => !document.querySelector('[role="dialog"]'),
            );
            assert.equal(
              await page.evaluate(() => document.querySelector('audio').paused),
              false,
            );
            await page
              .getByRole('button', { name: 'Expand player controls' })
              .click();
          }
          await page.locator('audio').evaluate((el) => {
            el.currentTime = 57;
            el.dispatchEvent(new Event('timeupdate'));
          });
          await page.waitForFunction(
            () => document.querySelector('audio').currentTime >= 57,
          );
          await closeAndVerify(page, 57);
        } finally {
          await context.close();
        }
      });
    }
    for (const width of [1024, 1280, 1440, 1920]) {
      await t.test(
        `desktop player spacing and speed popup at ${width}px`,
        async () => {
          const viewport = { width, height: 900 };
          const { context, page } = await openPlayer(viewport, false, {
            title:
              'Shiur #13 - עוד בענין קטמה והבערה with a long recording title',
          });
          try {
            const player = page.getByRole('region', {
              name: 'Audio player',
              exact: true,
            });
            const layout = await player.evaluate((el) => {
              const bounds = (selector) =>
                el.querySelector(selector).getBoundingClientRect().toJSON();
              return {
                track: bounds('.player-track'),
                main: bounds('.player-main'),
                options: bounds('.player-options'),
                close: bounds('.player-close'),
                player: el.getBoundingClientRect().toJSON(),
                background: getComputedStyle(el).backgroundColor,
              };
            });
            assert.ok(
              layout.track.right <= layout.main.x,
              'title and transport have separate columns',
            );
            assert.ok(
              layout.main.right <= layout.options.x,
              'options do not overlap the transport',
            );
            assert.ok(
              layout.close.right <= layout.player.right,
              'close button fits inside the bar',
            );
            assert.equal(
              layout.background,
              'rgb(24, 24, 27)',
              'page text cannot show through the player',
            );
            const trigger = player.getByRole('button', {
              name: 'Playback speed',
              exact: true,
            });
            await trigger.click();
            const popup = page.locator('.playback-speed-popup');
            await assertInViewport(popup, viewport);
            const popupBox = await popup.boundingBox();
            const triggerBox = await trigger.boundingBox();
            assert.ok(
              popupBox.y + popupBox.height <= layout.player.y - 9,
              'popup clears every compact player control',
            );
            assert.ok(
              Math.abs(
                popupBox.x +
                  popupBox.width / 2 -
                  triggerBox.x -
                  triggerBox.width / 2,
              ) < 1,
              'popup is anchored to the desktop speed button',
            );
          } finally {
            await context.close();
          }
        },
      );
    }
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 768, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await t.test(
        `fullscreen controls and speed at ${viewport.width}px`,
        async () => {
          const { context, page } = await openPlayer(viewport);
          const desktop = viewport.width >= 768;
          try {
            const open = page.getByRole('button', {
              name: desktop
                ? 'Open fullscreen player'
                : 'Expand player controls',
              exact: true,
            });
            await open.click();
            const dialog = page.locator('.mobile-now-playing');
            await assertInViewport(dialog, viewport);
            const controls = dialog.locator('.now-playing-actions');
            await controls.scrollIntoViewIfNeeded();
            const alignment = await controls.evaluate((row) => {
              const buttons = [...row.querySelectorAll(':scope > button')].map(
                (button) => button.getBoundingClientRect(),
              );
              return {
                widths: buttons.map((r) => r.width),
                centers: buttons.map((r) => r.y + r.height / 2),
                heights: buttons.map((r) => r.height),
                text: row.textContent,
              };
            });
            assert.ok(Math.abs(alignment.widths[0] - alignment.widths[1]) < 1);
            assert.ok(
              Math.max(...alignment.centers) - Math.min(...alignment.centers) <
                1,
            );
            assert.ok(alignment.heights.every((height) => height >= 44));
            assert.match(alignment.text, /Details/);
            assert.doesNotMatch(alignment.text, /Notes/);
            const speedButton = dialog.getByRole('button', {
              name: 'Playback speed',
              exact: true,
            });
            await speedButton.click();
            const popup = page.locator('.playback-speed-popup');
            await assertInViewport(popup, viewport);
            const popupBox = await popup.boundingBox();
            const playerBox = await dialog.boundingBox();
            const speedBox = await speedButton.boundingBox();
            if (desktop) {
              const portraitBox = await dialog
                .locator('.now-playing-portrait')
                .boundingBox();
              assert.ok(
                popupBox.x >= portraitBox.x + portraitBox.width,
                'desktop speed popup clears the portrait',
              );
            }
            assert.ok(
              desktop
                ? Math.abs(popupBox.x - speedBox.x) < 1
                : Math.abs(
                    popupBox.x +
                      popupBox.width / 2 -
                      (playerBox.x + playerBox.width / 2),
                  ) < 1,
              desktop
                ? 'desktop speed popup is aligned with its trigger'
                : 'mobile speed popup stays centered across the player',
            );
            assert.equal(
              await popup.evaluate(
                (el) => getComputedStyle(el).backgroundColor,
              ),
              'rgb(32, 32, 35)',
            );
            const speedSlider = popup.getByRole('slider', {
              name: 'Playback speed',
            });
            await speedSlider.press('End');
            await page.waitForFunction(
              () => document.querySelector('audio').playbackRate === 3,
            );
            await speedSlider.press('ArrowLeft');
            await speedSlider.press('ArrowLeft');
            await page.waitForFunction(
              () => document.querySelector('audio').playbackRate === 2.5,
            );
            assert.match(await speedButton.textContent(), /2\.5× speed/);
            await page.keyboard.press('Escape');
            await popup.waitFor({ state: 'hidden' });
            assert.equal(await dialog.isVisible(), true);
            assert.equal(
              await speedButton.evaluate(
                (button) => button === document.activeElement,
              ),
              true,
            );
            await speedButton.click();
            await popup.getByRole('button', { name: 'Reset to 1×' }).click();
            await page.waitForFunction(
              () => document.querySelector('audio').playbackRate === 1,
            );
            await speedSlider.press('Home');
            await page.waitForFunction(
              () => document.querySelector('audio').playbackRate === 0.75,
            );
            await speedSlider.press('End');
            await page.waitForFunction(
              () => document.querySelector('audio').playbackRate === 3,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  JSON.parse(localStorage.getItem('yutorah-learning-v1')).speed,
              ),
              3,
            );
            await page.keyboard.press('Escape');
            await popup.waitFor({ state: 'hidden' });
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'hidden' });
            assert.equal(
              await page.locator('audio').evaluate((audio) => audio.paused),
              false,
            );
            assert.equal(
              await open.evaluate(
                (button) => button === document.activeElement,
              ),
              true,
            );
            await open.click();
            await closeAndVerify(page);
          } finally {
            await context.close();
          }
        },
      );
    }
    await t.test(
      'official transcripts seek audio and read hosted notes without notes polling',
      async () => {
        const { context, page } = await openPlayer({ width: 390, height: 844 });
        let reads = 0,
          statuses = 0,
          noteReads = 0;
        let unavailable = false;
        try {
          await context.route('**/api/transcript?*', (route) => {
            reads++;
            return unavailable
              ? route.fulfill({
                  status: 503,
                  json: { error: 'Temporarily unavailable' },
                })
              : route.fulfill({
                  json: {
                    id: '900001',
                    source: 'official-yutorah',
                    transcriptId: 'official-900001-fixture',
                    version: 'c'.repeat(64),
                    title: shiur.title,
                    teacher: shiur.teacher,
                    segments: [
                      {
                        startMs: 0,
                        endMs: 12000,
                        text: 'Official transcript from YUTorah.',
                        speaker: null,
                      },
                      {
                        startMs: 12345,
                        endMs: 60000,
                        text: 'שָׁלוֹם, second timed passage.',
                        speaker: null,
                      },
                    ],
                    notes: null,
                  },
                });
          });
          await context.route('**/api/transcript-status?*', (route) => {
            statuses++;
            return route.fulfill({ status: 503, json: { error: 'Unused' } });
          });
          await context.route('**/api/study-notes?*', (route) => {
            noteReads++;
            return route.fulfill({
              json: {
                status: 'completed',
                markdown:
                  '# Hosted notes\n\n## תשובה\n\n- Complete lecture notes.',
                sourceHash: 'c'.repeat(64),
              },
            });
          });
          await page.clock.install();
          await page
            .getByRole('button', { name: 'Expand player controls' })
            .click();
          await page
            .getByRole('button', { name: 'Open shiur details and notes' })
            .click();
          const region = page.getByRole('region', {
            name: 'Transcript, notes, and sources',
            exact: true,
          });
          await region
            .getByText('Official transcript from YUTorah.', { exact: true })
            .waitFor();
          assert.equal(
            await region
              .getByRole('button', { name: 'Notes', exact: true })
              .count(),
            1,
          );
          assert.equal(
            await region
              .getByRole('button', { name: 'Sources', exact: true })
              .count(),
            0,
          );
          assert.match(
            await region
              .getByRole('link', { name: 'Open complete text' })
              .getAttribute('href'),
            /version=c{64}&source=official-yutorah$/,
          );
          await page.clock.fastForward(600_000);
          assert.equal(reads, 1);
          assert.equal(statuses, 0, 'official content has no notes polling');
          assert.equal(
            noteReads,
            0,
            'reading a transcript does not read TiDB notes',
          );
          await region
            .getByRole('button', { name: 'Play from 0:12', exact: true })
            .click();
          await page.waitForFunction(() => {
            const audio = document.querySelector('audio');
            return (
              audio && audio.currentTime >= 12.345 && audio.currentTime < 14
            );
          });
          unavailable = true;
          await region
            .getByRole('button', { name: 'Refresh', exact: true })
            .click();
          await region
            .getByText(/Your loaded transcript is still available/)
            .waitFor();
          await region
            .getByText('Official transcript from YUTorah.', { exact: true })
            .waitFor();
          assert.equal(reads, 2);
          assert.equal(statuses, 0);
          await region
            .getByRole('button', { name: 'Notes', exact: true })
            .click();
          await region.getByRole('heading', { name: 'Hosted notes' }).waitFor();
          await region.getByRole('heading', { name: 'תשובה' }).waitFor();
          assert.equal(noteReads, 1);
          await region
            .getByRole('button', { name: 'Transcript', exact: true })
            .click();
          await region
            .getByRole('button', { name: 'Notes', exact: true })
            .click();
          await region.getByRole('heading', { name: 'Hosted notes' }).waitFor();
          await page.clock.fastForward(600_000);
          assert.equal(
            noteReads,
            1,
            'tab switching and elapsed time reuse saved notes',
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'hosted notes remain readable when the initial transcript request fails',
      async () => {
        const { context, page } = await openPlayer({ width: 390, height: 844 });
        try {
          await context.route('**/api/transcript?*', (route) =>
            route.fulfill({
              status: 503,
              json: { error: 'Transcript temporarily unavailable' },
            }),
          );
          await context.route('**/api/study-notes?*', (route) =>
            route.fulfill({
              json: {
                status: 'completed',
                markdown:
                  '# Saved study notes\n\n## Teaching\n\n- Stored independently.',
              },
            }),
          );
          await page
            .getByRole('button', { name: 'Expand player controls' })
            .click();
          await page
            .getByRole('button', { name: 'Open shiur details and notes' })
            .click();
          const region = page.getByRole('region', {
            name: 'Transcript, notes, and sources',
            exact: true,
          });
          await region
            .getByText('Transcript temporarily unavailable', { exact: false })
            .waitFor();
          await region
            .getByRole('button', { name: 'Notes', exact: true })
            .click();
          await region
            .getByRole('heading', { name: 'Saved study notes', exact: true })
            .waitFor();
          assert.equal(
            await region
              .getByText('Stored independently.', { exact: true })
              .count(),
            1,
          );
          assert.equal(
            await region
              .getByRole('button', { name: 'Download', exact: true })
              .count(),
            1,
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'transcript notes polling pauses in hidden tabs, has a retry limit, and keeps manual refresh',
      async () => {
        const { context, page } = await openPlayer({ width: 390, height: 844 });
        let reads = 0,
          statuses = 0;
        let queued = true,
          unavailable = false;
        try {
          await context.route('**/api/transcript?*', (route) => {
            reads++;
            if (unavailable)
              return route.fulfill({
                status: 503,
                json: { error: 'Temporarily unavailable' },
              });
            return route.fulfill({
              json: {
                id: '900001',
                transcriptId: 'fixture-1',
                version: (queued ? 'a' : 'b').repeat(64),
                title: shiur.title,
                teacher: shiur.teacher,
                segments: [
                  {
                    startMs: 0,
                    endMs: 1000,
                    text: `Transcript read ${reads}`,
                    speaker: null,
                  },
                ],
                notes: {
                  status: queued ? 'queued' : 'completed',
                  markdown: queued ? null : '# Completed notes',
                },
              },
            });
          });
          await context.route('**/api/transcript-status?*', (route) => {
            statuses++;
            if (unavailable)
              return route.fulfill({
                status: 503,
                json: { error: 'Temporarily unavailable' },
              });
            return route.fulfill({
              json: {
                transcriptId: 'fixture-1',
                version: (queued ? 'a' : 'b').repeat(64),
                notes: { status: queued ? 'queued' : 'completed' },
              },
            });
          });
          await page.evaluate(() => {
            window.transcriptHidden = false;
            Object.defineProperty(document, 'hidden', {
              configurable: true,
              get: () => window.transcriptHidden,
            });
          });
          await page.clock.install();
          await page
            .getByRole('button', { name: 'Expand player controls' })
            .click();
          await page
            .getByRole('button', { name: 'Open shiur details and notes' })
            .click();
          await page.getByText('Transcript read 1', { exact: true }).waitFor();
          await page.evaluate(() => {
            window.transcriptHidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await page.clock.fastForward(600_000);
          assert.equal(reads, 1);
          assert.equal(
            statuses,
            0,
            'hidden readers make no background requests',
          );
          const resumedStatus = page.waitForResponse(
            '**/api/transcript-status?*',
          );
          await page.evaluate(() => {
            window.transcriptHidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await resumedStatus;
          for (let expected = 2; expected <= 10; expected++) {
            const response = page.waitForResponse('**/api/transcript-status?*');
            await page.clock.runFor(30_000);
            await response;
          }
          await page.clock.fastForward(600_000);
          assert.equal(statuses, 10, 'queued notes cannot poll indefinitely');
          assert.equal(
            reads,
            1,
            'status polls never download transcript bodies',
          );
          queued = false;
          await page
            .getByRole('region', {
              name: 'Transcript, notes, and sources',
            })
            .getByRole('button', { name: 'Refresh', exact: true })
            .click();
          await page.getByText('Transcript read 2', { exact: true }).waitFor();
          await page.evaluate(() => {
            window.transcriptHidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
            window.transcriptHidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await page.clock.fastForward(600_000);
          assert.equal(
            reads,
            2,
            'completed notes do not restart polling on tab focus',
          );
          assert.equal(
            statuses,
            11,
            'manual refresh checks the published version',
          );
          const unchangedStatus = page.waitForResponse(
            '**/api/transcript-status?*',
          );
          await page
            .getByRole('region', {
              name: 'Transcript, notes, and sources',
            })
            .getByRole('button', { name: 'Refresh', exact: true })
            .click();
          await unchangedStatus;
          await page.clock.fastForward(600_000);
          assert.equal(
            reads,
            2,
            'an unchanged immutable version reuses its content',
          );
          assert.equal(statuses, 12);
          unavailable = true;
          await page
            .getByRole('region', {
              name: 'Transcript, notes, and sources',
            })
            .getByRole('button', { name: 'Refresh', exact: true })
            .click();
          await page
            .getByText(/Your loaded transcript is still available/)
            .waitFor();
          await page.getByText('Transcript read 2', { exact: true }).waitFor();
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'phone mini-player closes without opening full view',
      async () => {
        const { context, page } = await openPlayer({ width: 390, height: 844 });
        try {
          await closeAndVerify(page);
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'closing while media is loading cancels pending playback',
      async () => {
        const { context, page } = await openPlayer(
          { width: 390, height: 844 },
          true,
        );
        try {
          await page.getByRole('button', { name: 'Play', exact: true }).click();
          await closeAndVerify(page);
        } finally {
          await context.close();
        }
      },
    );
    for (const width of [320, 390, 667]) {
      await t.test(
        `phone details sheet fills, centers, and scrolls in ${width}px`,
        async () => {
          const viewport = { width, height: 844 };
          const description =
            'A longer shiur description for scrolling. '.repeat(40);
          const { context, page } = await openPlayer(viewport, false, {
            onPage: async (_page, context) => {
              await context.route('**/api/shiur?id=900001', (route) =>
                route.fulfill({ json: { ...shiur, description } }),
              );
            },
          });
          try {
            await page
              .getByRole('button', { name: 'Expand player controls' })
              .click();
            await page
              .getByRole('button', { name: 'Open shiur details and notes' })
              .click();
            const sheet = page.getByRole('dialog', {
              name: 'Shiur details',
              exact: true,
            });
            await sheet.waitFor();
            await sheet
              .getByText(description, { exact: true })
              .waitFor({ state: 'attached' });
            await page.waitForFunction(() => {
              const panel = document.querySelector('.detail-sheet');
              return (
                panel &&
                !panel.hasAttribute('data-starting-style') &&
                panel
                  .getAnimations()
                  .every((animation) => animation.playState === 'finished')
              );
            });
            await assertInViewport(sheet, viewport);
            const rect = await sheet.boundingBox();
            assert.ok(Math.abs(rect.width - width) <= 1, JSON.stringify(rect));
            assert.ok(
              Math.abs(rect.x + rect.width / 2 - width / 2) <= 1,
              JSON.stringify(rect),
            );
            assert.ok(
              await sheet.evaluate(
                (panel) => panel.scrollHeight > panel.clientHeight,
              ),
              'details include content below the phone viewport',
            );
            await sheet.hover();
            await page.mouse.wheel(0, 500);
            await page.waitForFunction(
              () => document.querySelector('.detail-sheet')?.scrollTop > 0,
              undefined,
              { timeout: 2000 },
            );
            await page.mouse.wheel(0, 10000);
            await page.waitForFunction(() => {
              const panel = document.querySelector('.detail-sheet');
              return (
                panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1
              );
            });
            await assertInViewport(
              sheet.locator('.original-shiur-link'),
              viewport,
            );
          } finally {
            await context.close();
          }
        },
      );
    }
    for (const pixelRatio of [1, 2, 3]) {
      for (const missingOriginal of [false, true]) {
        await t.test(
          `portrait stays large at ${pixelRatio}x density, original missing=${missingOriginal}`,
          async () => {
            const { context, page } = await openPlayer(
              { width: 390, height: 844 },
              false,
              {
                pixelRatio,
                missingOriginal,
                image:
                  'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/player-fixture.jpg',
              },
            );
            try {
              await page
                .getByRole('button', { name: 'Expand player controls' })
                .click();
              const portrait = page.locator('.now-playing-portrait img');
              await portrait.waitFor();
              await page.waitForFunction(
                () =>
                  document.querySelector('.now-playing-portrait img')
                    ?.naturalWidth > 0,
              );
              const pixels = await portrait.evaluate((img) => ({
                width: img.getBoundingClientRect().width,
                height: img.getBoundingClientRect().height,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                source: img.currentSrc,
              }));
              assert.equal(pixels.naturalWidth, missingOriginal ? 50 : 240);
              assert.ok(
                pixels.width >= 220 && pixels.width <= 230,
                JSON.stringify(pixels),
              );
              assert.ok(
                pixels.height >= 255 && pixels.height <= 269,
                JSON.stringify(pixels),
              );
              assert.equal(pixels.source.includes('_lp.jpg'), !missingOriginal);
            } finally {
              await context.close();
            }
          },
        );
      }
    }
    for (const width of [390, 1280]) {
      await t.test(
        `sources recovery and customized sheet export at ${width}px`,
        async () => {
          const { context, page } = await openPlayer({ width, height: 844 });
          try {
            const segments = [
              { text: 'Genesis 1:1', startMs: 0, endMs: 30000 },
              { text: 'Shabbat 2b', startMs: 30000, endMs: 60000 },
              { text: 'Exodus 1:1', startMs: 60000, endMs: 90000 },
            ];
            await context.route('**/api/transcript?id=900001', (route) =>
              route.fulfill({
                json: {
                  id: '900001',
                  transcriptId: 'source-ui-fixture',
                  title: 'Source controls fixture',
                  teacher: 'Test teacher',
                  text: segments.map((s) => s.text).join(' '),
                  segments,
                  notes: {
                    status: 'completed',
                    markdown: 'Notes',
                    cleanedText: null,
                  },
                },
              }),
            );
            const sources = segments.map((segment, index) => ({
              ref: segment.text,
              heRef: 'הפניה',
              url:
                'https://www.sefaria.org/' + segment.text.replaceAll(' ', '_'),
              category: index === 1 ? 'Talmud' : 'Tanakh',
              occurrences: [
                {
                  offset: index * 20,
                  startMs: segment.startMs,
                  endMs: segment.endMs,
                  mention: segment.text,
                  spans: [
                    {
                      segmentIndex: index,
                      startChar: 0,
                      endChar: segment.text.length,
                    },
                  ],
                },
              ],
            }));
            let sourceCalls = 0,
              textCalls = 0;
            await context.route('**/api/sources?**', (route) => {
              sourceCalls++;
              return route.fulfill(
                sourceCalls === 1
                  ? {
                      status: 503,
                      json: { error: 'Temporary failure' },
                      headers: { 'Retry-After': '1' },
                    }
                  : {
                      json: {
                        transcriptId: 'source-ui-fixture',
                        status: 'ready',
                        progress: 100,
                        sources,
                        omitted: 1,
                        limited: false,
                        omissionCounts: { missing_amud: 1 },
                        omissions: [
                          {
                            reason: 'missing_amud',
                            mention: 'Shabbat 2',
                            offset: 100,
                            startMs: 10000,
                          },
                        ],
                      },
                    },
              );
            });
            await context.route('**/api/source-text?**', (route) => {
              textCalls++;
              const params = new URL(route.request().url()).searchParams;
              const ref = params.get('ref');
              const lines = params.get('extent') === 'full' ? 12 : 8;
              return route.fulfill({
                json: {
                  ref,
                  categories: [
                    'Library',
                    ref.startsWith('Shabbat') ? 'Talmud' : 'Tanakh',
                  ],
                  editions: [
                    {
                      title: 'Original fixture edition',
                      language: 'he',
                      direction: 'rtl',
                      license: 'Public Domain',
                      versionSource: null,
                      text: ['מקור לדוגמה'],
                      truncated: false,
                    },
                    {
                      title: 'English fixture edition',
                      language: 'en',
                      direction: 'ltr',
                      license: 'CC-BY',
                      versionSource: null,
                      text: Array.from(
                        { length: lines },
                        (_, i) => `English line ${i + 1}`,
                      ),
                      truncated: lines === 8,
                    },
                  ],
                },
              });
            });
            if (width < 768)
              await page
                .getByRole('button', { name: 'Expand player controls' })
                .click();
            await page
              .getByRole('button', { name: 'Open shiur details and notes' })
              .click();
            await page
              .getByRole('button', { name: 'Sources', exact: true })
              .click();
            await page
              .getByRole('button', { name: 'Preview source sheet' })
              .waitFor();
            assert.equal(
              sourceCalls,
              2,
              'temporary failure recovers automatically',
            );
            await page.getByText('Why references were omitted (1)').click();
            assert.ok(
              await page.getByText('Missing an explicit amud: 1').isVisible(),
            );
            await page
              .getByRole('button', { name: 'Preview source sheet' })
              .click();
            const sheet = page.getByRole('region', {
              name: 'Source sheet preview',
            });
            await sheet
              .getByRole('button', { name: 'Download sheet' })
              .waitFor();
            await page.waitForFunction(
              () =>
                !document.querySelector('.source-sheet-tools button').disabled,
            );
            await sheet
              .getByLabel('Language', { exact: true })
              .selectOption('en');
            assert.equal(await sheet.getByText('מקור לדוגמה').count(), 0);
            await sheet.getByText('Choose sources (3 of 3)').click();
            await sheet.getByLabel('Exodus 1:1', { exact: true }).uncheck();
            await sheet
              .getByLabel('Source text', { exact: true })
              .selectOption('full');
            await sheet
              .getByLabel('Order', { exact: true })
              .selectOption('category');
            await page.waitForFunction(
              () =>
                !document.querySelector('.source-sheet-tools button').disabled,
            );
            assert.equal(await sheet.locator('article').count(), 2);
            assert.ok(
              (await sheet.locator('article').first().innerText()).includes(
                'Shabbat 2b',
              ),
            );
            assert.equal(
              await sheet.getByText('English line 12', { exact: true }).count(),
              2,
            );
            const [download] = await Promise.all([
              page.waitForEvent('download'),
              sheet.getByRole('button', { name: 'Download sheet' }).click(),
            ]);
            const html = await readFile(await download.path(), 'utf8');
            assert.ok(html.includes('English line 12'));
            assert.ok(!html.includes('מקור לדוגמה'));
            assert.ok(!html.includes('Exodus 1:1'));
            assert.ok(html.includes('CC-BY'));
            assert.ok(html.indexOf('Shabbat 2b') < html.indexOf('Genesis 1:1'));
            const before = textCalls;
            await sheet
              .getByLabel('Language', { exact: true })
              .selectOption('he');
            assert.equal(
              textCalls,
              before,
              'changing language reuses the loaded editions',
            );
            assert.equal(
              await sheet.getByText('English line 12', { exact: true }).count(),
              0,
            );
            assert.equal(await sheet.getByText('מקור לדוגמה').count(), 2);
            await sheet
              .getByRole('button', { name: 'Clear selection' })
              .click();
            assert.ok(
              await sheet
                .getByRole('button', { name: 'Download sheet' })
                .isDisabled(),
            );
            assert.equal(await sheet.locator('article').count(), 0);
            const overflow = await sheet.evaluate(
              (el) => el.scrollWidth > el.clientWidth + 1,
            );
            assert.equal(overflow, false);
          } finally {
            await context.close();
          }
        },
      );
    }
  } finally {
    if (process.env.PERFORMANCE_CSS_REPORT) {
      const report = [...cssCoverage].map(([path, entry]) => {
        let used = 0,
          end = 0;
        for (const [start, next] of [...entry.ranges.values()].sort(
          (a, b) => a[0] - b[0],
        )) {
          used += Math.max(0, next - Math.max(end, start));
          end = Math.max(end, next);
        }
        return {
          path,
          characters: entry.characters,
          usedRuleCharacters: used,
          usedPercent: +((100 * used) / entry.characters).toFixed(2),
        };
      });
      await writeFile(
        process.env.PERFORMANCE_CSS_REPORT,
        JSON.stringify(report, null, 2),
      );
    }
    await browser.close();
    server?.kill();
    if (state) await rm(state, { recursive: true, force: true });
  }
});
