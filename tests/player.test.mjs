import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
    image: options.image || '',
    teacherId: options.teacherId || shiur.teacherId,
    teacher: options.teacher || shiur.teacher,
  };
  await context.addInitScript((s) => {
    if (!localStorage.getItem('yutorah-learning-v1'))
      localStorage.setItem(
        'yutorah-learning-v1',
        JSON.stringify({
          last: s,
          history: [{ shiur: s, seconds: 42, duration: 120 }],
          queue: [{ ...s, id: 900002 }],
        }),
      );
  }, recording);
  await context.route('**/api/shiur?id=900001', (route) =>
    route.fulfill({ json: recording }),
  );
  if (options.missingHighResolution)
    await context.route('**/images/teachers/aryeh-lebowitz.jpg', (route) =>
      route.fulfill({ status: 404, body: '' }),
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
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
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
    await t.test(
      'transcript notes polling pauses in hidden tabs, has a retry limit, and keeps manual refresh',
      async () => {
        const { context, page } = await openPlayer({ width: 390, height: 844 });
        let reads = 0;
        let queued = true;
        try {
          await context.route('**/api/transcript?id=900001', (route) => {
            reads++;
            return route.fulfill({
              json: {
                id: '900001',
                transcriptId: 'polling-ui-fixture',
                title: shiur.title,
                teacher: shiur.teacher,
                text: `Transcript read ${reads}`,
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
          await page.clock.runFor(600_000);
          assert.equal(reads, 1, 'hidden readers make no background requests');
          await page.evaluate(() => {
            window.transcriptHidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await page.getByText('Transcript read 2', { exact: true }).waitFor();
          for (let expected = 3; expected <= 11; expected++) {
            await page.clock.runFor(30_000);
            await page
              .getByText(`Transcript read ${expected}`, { exact: true })
              .waitFor();
          }
          await page.clock.runFor(600_000);
          assert.equal(reads, 11, 'queued notes cannot poll indefinitely');
          queued = false;
          await page
            .getByRole('region', {
              name: 'Transcript, study notes, and sources',
            })
            .getByRole('button', { name: 'Refresh', exact: true })
            .click();
          await page.getByText('Transcript read 12', { exact: true }).waitFor();
          await page.evaluate(() => {
            window.transcriptHidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
            window.transcriptHidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await page.clock.runFor(600_000);
          assert.equal(
            reads,
            12,
            'completed notes do not restart polling on tab focus',
          );
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
        `phone details sheet fills and centers in ${width}px`,
        async () => {
          const viewport = { width, height: 844 };
          const { context, page } = await openPlayer(viewport);
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
    for (const missingHighResolution of [false, true]) {
      await t.test(
        `Lebowitz portrait is large and uses the verified original, missing=${missingHighResolution}`,
        async () => {
          const { context, page } = await openPlayer(
            { width: 390, height: 844 },
            false,
            {
              pixelRatio: 3,
              teacherId: 80714,
              teacher: 'Rabbi Aryeh Lebowitz',
              missingHighResolution,
              image:
                'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/player-fixture.jpg',
            },
          );
          try {
            await page
              .getByRole('button', { name: 'Expand player controls' })
              .click();
            await page.waitForFunction(() => {
              const img = document.querySelector('.now-playing-portrait img');
              return img?.complete && img.naturalWidth > 0;
            });
            const pixels = await page
              .locator('.now-playing-portrait img')
              .evaluate((img) => ({
                width: img.getBoundingClientRect().width,
                height: img.getBoundingClientRect().height,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                source: img.currentSrc,
              }));
            assert.ok(pixels.width >= 220 && pixels.width <= 230);
            if (missingHighResolution) {
              assert.ok(pixels.source.endsWith('player-fixture_lp.jpg'));
              assert.equal(pixels.naturalWidth, 240);
            } else {
              assert.ok(
                pixels.source.endsWith('/images/teachers/aryeh-lebowitz.jpg'),
              );
              assert.equal(pixels.naturalWidth, 5602);
              assert.equal(pixels.naturalHeight, 3735);
              assert.ok(pixels.width * 3 <= pixels.naturalWidth);
              assert.ok(pixels.height * 3 <= pixels.naturalHeight);
            }
          } finally {
            await context.close();
          }
        },
      );
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
    await browser.close();
    server?.kill();
    if (state) await rm(state, { recursive: true, force: true });
  }
});
