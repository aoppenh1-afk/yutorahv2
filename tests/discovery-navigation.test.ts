import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { normalize, parseSearch } from '../lib/yutorah';
import { dafTractates } from '../lib/daf';
import { emptyFacets } from '../lib/catalog';

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:3020';
const state = process.env.TEST_ORIGIN
  ? null
  : await mkdtemp(join(tmpdir(), 'yutorah-navigation-'));
const server = state
  ? spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '--config',
        'dist/server/wrangler.json',
        '--port',
        '3020',
        '--inspector-port',
        '0',
        '--persist-to',
        state,
      ],
      { stdio: 'ignore' },
    )
  : null;
let browser: Awaited<ReturnType<typeof chromium.launch>>;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(3000) })).ok)
        break;
    } catch {}
    if (attempt >= 30 || (server && server.exitCode !== null))
      throw new Error('Build the application before running navigation tests.');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  browser = await chromium.launch();
} catch (error) {
  server?.kill();
  if (state) await rm(state, { recursive: true, force: true });
  throw error;
}
test.after(async () => {
  await browser.close();
  server?.kill();
  if (state) await rm(state, { recursive: true, force: true });
});

const recordings = [900101, 900102].map((id, index) => ({
  ...normalize({
    shiurID: id,
    shiurTitle: index
      ? 'Second navigation recording'
      : 'First navigation recording',
    shiurFileURL: origin + '/navigation-fixture.wav',
    shiurDate: '2026-10-01',
  }),
  teacherId: 80153,
  teacher: 'Rabbi Hershel Schachter',
  duration: 120,
  category: 'Halacha',
  collections: [{ id: 42, name: 'Navigation collection' }],
}));
const directory = {
  teachers: [
    {
      id: 80153,
      name: 'Rabbi Hershel Schachter',
      firstName: 'Hershel',
      lastName: 'Schachter',
      count: 2,
      image: origin + '/favicon.svg',
    },
  ],
  series: [
    {
      id: 17,
      name: 'Navigation series',
      description: '',
      count: 2,
      image: origin + '/images/art/hero-library.webp',
    },
  ],
  topics: [],
  groups: [],
};
// Seekable local audio lets history checks exercise real playback without a CDN.
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

async function fixtures(context: BrowserContext) {
  const requests: URL[] = [];
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname === '/api/home')
      return route.fulfill({
        json: {
          featured: recordings,
          recent: [],
          daily: [],
          recentlyViewed: [],
          series: directory.series,
          total: 2,
          hebrewDate: '',
          daf: 'Bechorot 29',
          nach: '',
          mishna: '',
          fetchedAt: '2026-10-17T00:00:00Z',
        },
      });
    if (url.pathname === '/api/directory')
      return route.fulfill({ json: directory });
    if (url.pathname === '/api/suggestions')
      return route.fulfill({
        json: {
          items: recordings.map((s) => ({
            kind: 'shiur',
            id: s.id,
            name: s.title,
            teacher: s.teacher,
            context: s.teacher,
          })),
        },
      });
    if (url.pathname === '/api/shiur')
      return route.fulfill({
        json: recordings.find(
          (s) => s.id === Number(url.searchParams.get('id')),
        ),
      });
    if (url.pathname === '/api/search')
      return route.fulfill({
        json: {
          items: recordings,
          total: 2,
          sourceTotal: 2,
          scanned: 2,
          complete: true,
          plan: parseSearch(url.searchParams.get('q') || '', {}, directory),
          filtered: false,
          nextPage: null,
          facets: emptyFacets(),
        },
      });
    if (url.pathname === '/api/catalog') {
      const action = url.searchParams.get('action');
      if (action === 'daf')
        return route.fulfill({
          json: {
            tractate: url.searchParams.get('tractate'),
            page: Number(url.searchParams.get('page')),
            side: url.searchParams.get('side'),
            image: '',
            items: recordings,
            related: [],
            tractates: dafTractates,
            sideCounts: { a: 2, b: 2 },
          },
        });
      if (action === 'neighbors') {
        const index = recordings.findIndex(
          (s) => s.id === Number(url.searchParams.get('shiur')),
        );
        return route.fulfill({
          json: {
            id: 42,
            name: 'Navigation collection',
            version: 'a'.repeat(64),
            count: 2,
            index,
            current: recordings[index],
            previous: recordings[index - 1] || null,
            next: recordings[index + 1] || null,
          },
        });
      }
      if (action === 'entity') {
        const kind = url.searchParams.get('kind');
        return route.fulfill({
          json: {
            kind,
            id: Number(url.searchParams.get('id')),
            name:
              kind === 'teacher'
                ? directory.teachers[0].name
                : directory.series[0].name,
            count: 2,
            description: '',
            image: '',
            recent: recordings,
            popular: [],
            featured: [],
            facets: emptyFacets(),
          },
        });
      }
      return route.fulfill({ json: { entries: [], total: 0, next: null } });
    }
    if (url.pathname === '/api/shiur-views')
      return route.fulfill({ json: { views: {} } });
    return route.fulfill({
      json: {
        items: [],
        entries: [],
        segments: [],
        partial: false,
        status: 'unavailable',
        available: false,
        chapters: [],
        summary: '',
      },
    });
  });
  await context.route('**/navigation-fixture.wav', async (route) => {
    const range = route
      .request()
      .headers()
      .range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(Number(range[2]), wav.length - 1)
      : wav.length - 1;
    await route.fulfill({
      status: range ? 206 : 200,
      contentType: 'audio/wav',
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        ...(range
          ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` }
          : {}),
      },
      body: wav.subarray(start, end + 1),
    });
  });
  return requests;
}
async function openDetails(page: Page, mobile: boolean) {
  const trigger = mobile
    ? page.locator('.m-hero-portrait')
    : page.getByRole('button', { name: 'Shiur details', exact: true });
  await trigger.click();
  await page
    .getByRole('dialog')
    .getByRole('heading', { name: recordings[0].title, exact: true })
    .waitFor();
  return trigger;
}

void test(
  'sampled search timings report separate committed operations without query data',
  { timeout: 30_000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const reports: {
      metrics: Record<string, number>;
      operations: { area: string; phase: string; ms: number; source: string }[];
    }[] = [];
    try {
      await context.addInitScript(() =>
        sessionStorage.setItem('yutorah-performance-sample', '1'),
      );
      await fixtures(context);
      await context.route('**/api/performance', async (route) => {
        reports.push(route.request().postDataJSON());
        await route.fulfill({ status: 204 });
      });
      await context.route('**/api/search?*', async (route) => {
        const params = new URL(route.request().url()).searchParams;
        const query = params.get('q') || '';
        const second = query === 'private_query_two';
        const partial = !second && !params.has('run');
        await route.fulfill({
          json: {
            items: [
              {
                ...recordings[0],
                id: second ? 900202 : 900201,
                title: second
                  ? 'Second timing result'
                  : partial
                    ? 'First timing result'
                    : 'First complete timing result',
              },
            ],
            total: 1,
            sourceTotal: 1,
            scanned: 1,
            complete: !partial,
            run: partial ? 'timing-pass' : undefined,
            retryAfterMs: 150,
            filtered: false,
            nextPage: null,
            facets: emptyFacets(),
            plan: parseSearch(query, {}, directory),
          },
        });
      });
      const page = await context.newPage();
      await page.goto(origin + '/?view=search&q=private_query_one');
      await page
        .getByText('First timing result', { exact: true })
        .first()
        .waitFor();
      await page
        .getByText('First complete timing result', { exact: true })
        .first()
        .waitFor();
      await page.locator('#main-search').fill('private_query_two');
      await page.locator('#main-search').press('Enter');
      await page
        .getByText('Second timing result', { exact: true })
        .first()
        .waitFor();
      await page.waitForFunction(() =>
        performance
          .getEntriesByType('resource')
          .some((entry) => /performance-reporter-/.test(entry.name)),
      );
      const request = page.waitForResponse('**/api/performance');
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await request;
      const operations = reports
        .flatMap((report) => report.operations)
        .filter((operation) => operation.area === 'search');
      assert.equal(
        operations.filter((operation) => operation.phase === 'first').length,
        2,
      );
      assert.equal(
        operations.filter((operation) => operation.phase === 'complete').length,
        2,
      );
      assert.ok(
        operations[0].ms < operations[1].ms,
        'progressive first results commit before search completion',
      );
      assert.ok(
        operations.every(
          (operation) => operation.ms >= 0 && operation.source === 'network',
        ),
      );
      assert.ok(
        reports.every((report) => !('searchVisibleMs' in report.metrics)),
      );
      assert.ok(!JSON.stringify(reports).includes('private_query'));
    } finally {
      await context.close();
    }
  },
);

void test(
  'controlled Home and first-interaction loading measurements',
  {
    skip: !process.env.HOME_LOADING_BENCHMARK,
    timeout: 180_000,
  },
  async () => {
    for (const entry of ['home', 'shared']) {
      for (const width of [1280, 390]) {
        for (let run = 0; run < 3; run++) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            serviceWorkers: 'block',
          });
          try {
            await context.addInitScript(() => {
              Math.random = () => 0.5;
            });
            await fixtures(context);
            const page = await context.newPage();
            page.setDefaultTimeout(30_000);
            const session = await context.newCDPSession(page);
            await session.send('Network.enable');
            await session.send('Network.emulateNetworkConditions', {
              offline: false,
              latency: 80,
              downloadThroughput: 180_000,
              uploadThroughput: 90_000,
            });
            await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
            await session.send('Performance.enable');
            const scripts: string[] = [];
            page.on('request', (request) => {
              if (
                request.resourceType() === 'script' &&
                new URL(request.url()).pathname.startsWith('/_next/')
              )
                scripts.push(request.url());
            });
            const queueDownload = async () => {
              const before = scripts.length;
              const started = performance.now();
              await page
                .getByRole('button', {
                  name: 'Download for offline',
                  exact: true,
                })
                .click();
              await page
                .getByRole('button', {
                  name: /^(Cancel download|Retry download)$/,
                })
                .waitFor();
              assert.equal(
                scripts.length - before,
                0,
                'the first download command must reuse the warmed manager: ' +
                  JSON.stringify(scripts.slice(before)),
              );
              return Math.round(performance.now() - started);
            };
            const started = performance.now();
            await page.goto(
              origin +
                (entry === 'shared' ? '/?shiur=' + recordings[0].id : '/'),
              { waitUntil: 'domcontentloaded' },
            );
            if (entry === 'shared') {
              await page
                .getByRole('dialog')
                .getByRole('heading', {
                  name: recordings[0].title,
                  exact: true,
                })
                .waitFor();
              const detailMs = Math.round(performance.now() - started);
              const downloadQueueMs = await queueDownload();
              console.log(
                JSON.stringify({
                  benchmark: 'shared-first-detail',
                  origin,
                  width,
                  run,
                  detailMs,
                  downloadQueueMs,
                }),
              );
              continue;
            }
            await (
              width < 768
                ? page.locator('.m-hero-portrait')
                : page.getByRole('button', {
                    name: 'Shiur details',
                    exact: true,
                  })
            ).waitFor();
            const homeMs = performance.now() - started;
            const homeScripts = scripts.length;
            const beforeAbout = scripts.length;
            const aboutStarted = performance.now();
            await page
              .getByRole('button', { name: 'About the library', exact: true })
              .click();
            await page
              .getByRole('dialog', { name: 'About the library' })
              .waitFor();
            const aboutMs = performance.now() - aboutStarted;
            const aboutScripts = scripts.length - beforeAbout;
            assert.equal(
              aboutScripts,
              0,
              'opening an eager dialog must not wait for another JS download',
            );
            await page.keyboard.press('Escape');
            await page.getByRole('dialog').waitFor({ state: 'hidden' });
            const detailStarted = performance.now();
            await openDetails(page, width < 768);
            const detailMs = performance.now() - detailStarted;
            const beforePlay = scripts.length;
            const playStarted = performance.now();
            await page
              .getByRole('button', { name: 'Listen', exact: true })
              .click();
            await page.waitForFunction(() => {
              const audio = document.querySelector('audio');
              return audio && !audio.paused && audio.currentTime > 0;
            });
            const playMs = performance.now() - playStarted;
            assert.equal(
              scripts.length - beforePlay,
              0,
              'first playback must not wait for another JS download',
            );
            const downloadQueueMs = await queueDownload();
            const metrics = (await session.send('Performance.getMetrics'))
              .metrics;
            console.log(
              JSON.stringify({
                benchmark: 'home-first-interaction',
                origin,
                width,
                run,
                homeMs: Math.round(homeMs),
                aboutMs: Math.round(aboutMs),
                detailMs: Math.round(detailMs),
                playMs: Math.round(playMs),
                downloadQueueMs,
                homeScripts,
                aboutScripts,
                scriptDurationMs: Math.round(
                  (metrics.find((m) => m.name === 'ScriptDuration')?.value ??
                    0) * 1000,
                ),
              }),
            );
          } finally {
            await context.close();
          }
        }
      }
    }
  },
);

for (const width of [1280, 390]) {
  void test(
    `details use one history entry, restore with Forward, and preserve playback at ${width}px`,
    { timeout: 30_000 },
    async () => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      await fixtures(context);
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      try {
        await page.goto(origin + '/?view=browse');
        await page
          .getByRole('heading', { name: 'Browse.', exact: true })
          .waitFor();
        await page.locator('.header-home').click();
        const trigger = await openDetails(page, width < 768);
        assert.equal(
          new URL(page.url()).searchParams.get('shiur'),
          String(recordings[0].id),
        );
        const entries = await page.evaluate(() => history.length);
        await page.getByRole('button', { name: 'Listen', exact: true }).click();
        await page.waitForFunction(() => {
          const audio = document.querySelector('audio');
          return audio && !audio.paused && audio.currentTime > 0;
        });
        await page
          .getByRole('button', { name: 'Next lesson', exact: true })
          .click();
        await page
          .getByRole('dialog')
          .getByRole('heading', { name: recordings[1].title, exact: true })
          .waitFor();
        assert.equal(
          new URL(page.url()).searchParams.get('shiur'),
          String(recordings[1].id),
        );
        assert.equal(await page.evaluate(() => history.length), entries);
        await page.goBack();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        assert.equal(page.url(), origin + '/');
        assert.equal(
          await page
            .locator('audio')
            .evaluate((audio: HTMLAudioElement) => audio.paused),
          false,
        );
        await page.waitForFunction(
          (element) => element === document.activeElement,
          await trigger.elementHandle(),
        );
        await page.goForward();
        await page
          .getByRole('dialog')
          .getByRole('heading', { name: recordings[1].title, exact: true })
          .waitFor();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Close', exact: true })
          .click();
        await page.waitForURL(origin + '/');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.goBack();
        await page.waitForURL(origin + '/?view=browse');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
      } finally {
        await context.close();
      }
    },
  );
}

void test(
  'mobile Home offers keyboard-selectable teacher and shiur suggestions and direct study destinations',
  { timeout: 30_000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const requests = await fixtures(context);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    try {
      await page.goto(origin);
      const input = page.getByRole('combobox', {
        name: 'Search YUTorah',
        exact: true,
      });
      await input.fill('schachter');
      const teacher = page
        .getByRole('option')
        .filter({ hasText: directory.teachers[0].name })
        .first();
      await teacher.waitFor();
      await page.locator('.search-suggestion-panel').evaluate(async (panel) => {
        await Promise.all(
          panel
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const panel = await page
          .locator('.search-suggestion-panel')
          .boundingBox();
        assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= width);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth),
          width,
        );
        if (process.env.TEST_SCREENSHOT_DIR)
          await page.screenshot({
            path: join(
              process.env.TEST_SCREENSHOT_DIR,
              `yutorah-home-suggestions-${width}.png`,
            ),
          });
      }
      await input.press('ArrowDown');
      await input.press('Enter');
      await page.waitForURL('**/*view=entity&kind=teacher&id=80153');
      await page.locator('.header-home').click();
      await input.fill(recordings[0].title);
      await page
        .getByRole('option')
        .filter({ hasText: recordings[0].title })
        .waitFor();
      await input.press('ArrowDown');
      await input.press('Enter');
      await page
        .getByRole('dialog')
        .getByRole('heading', { name: recordings[0].title, exact: true })
        .waitFor();
      await page.goBack();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page
        .locator('.m-today')
        .getByRole('button', { name: /Daf Yomi/ })
        .click();
      await page.waitForURL('**/*view=daf&tractate=Bechorot&page=29&side=a');
      await page.locator('.header-home').click();
      await page.locator('.m-teachers').getByRole('button').first().click();
      await page.waitForURL('**/*view=entity&kind=teacher&id=80153');
      await page.locator('.header-home').click();
      await page.locator('.m-series').getByRole('button').first().click();
      await page.waitForURL('**/*view=entity&kind=series&id=17');
      assert.equal(
        requests.some((url) => url.pathname === '/api/search'),
        false,
      );
    } finally {
      await context.close();
    }
  },
);

void test(
  'a direct timestamp link closes in place and waits for explicit playback',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext();
    await fixtures(context);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    try {
      const base = origin + '/?view=entity&kind=teacher&id=80153';
      await page.goto(base + '&shiur=900101&t=15');
      await page
        .getByRole('dialog')
        .getByRole('heading', { name: recordings[0].title, exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator('audio')
          .evaluate((audio: HTMLAudioElement) => audio.paused),
        true,
      );
      await page.getByRole('button', { name: 'Listen', exact: true }).click();
      await page.waitForFunction(
        () => (document.querySelector('audio')?.currentTime || 0) >= 15,
      );
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(page.url(), base);
      assert.equal(
        await page
          .locator('audio')
          .evaluate((audio: HTMLAudioElement) => audio.paused),
        false,
      );
    } finally {
      await context.close();
    }
  },
);

void test(
  'Back and Forward around search details preserve the loaded search without another scan',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext();
    const requests = await fixtures(context);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    try {
      const base = origin + '/?view=search&q=navigation';
      await page.goto(base);
      const trigger = page
        .locator('.shiur-row')
        .first()
        .getByRole('button', { name: recordings[0].title, exact: true });
      await trigger.click();
      await page.getByRole('dialog').waitFor();
      await page.goBack();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(page.url(), base);
      await page.goForward();
      await page.getByRole('dialog').waitFor();
      assert.equal(
        requests.filter((url) => url.pathname === '/api/search').length,
        1,
      );
    } finally {
      await context.close();
    }
  },
);

void test(
  'Back cancels a pending title selection without reopening details after its response arrives',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    await fixtures(context);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await context.route('**/api/shiur?*', async (route) => {
      await held;
      await route.fallback();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    try {
      await page.goto(origin);
      const input = page.getByRole('combobox', {
        name: 'Search YUTorah',
        exact: true,
      });
      await input.fill(recordings[0].title);
      await page
        .getByRole('option')
        .filter({ hasText: recordings[0].title })
        .click();
      await page.waitForURL('**/*shiur=900101');
      await page.goBack();
      await page.waitForURL(origin + '/');
      release();
      await page.waitForLoadState('networkidle');
      assert.equal(await page.getByRole('dialog').count(), 0);
    } finally {
      release();
      await context.close();
    }
  },
);

void test(
  'an offline shiur opened from an already loaded page also restores with Forward',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await fixtures(context);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    try {
      await page.goto(origin);
      await page
        .getByRole('button', { name: 'Shiur details', exact: true })
        .waitFor();
      // Warm the lazy reader code, but not this recording's detail response.
      await page.waitForFunction(() =>
        performance
          .getEntriesByType('resource')
          .some((entry) => /\/shiur-detail-/.test(entry.name)),
      );
      await context.setOffline(true);
      await openDetails(page, false);
      await page.goBack();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.goForward();
      await page
        .getByRole('dialog')
        .getByRole('heading', { name: recordings[0].title, exact: true })
        .waitFor();
    } finally {
      await context.close();
    }
  },
);
