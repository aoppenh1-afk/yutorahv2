// Run against a built app: TEST_ORIGIN=http://localhost:3015 node --test tests/mobile-sheet.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.TEST_ORIGIN || 'http://localhost:3015';
let browser;
before(async () => {
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {},
  );
});
after(async () => browser?.close());

async function openSheet(t, width = 390) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    hasTouch: true,
  });
  t.after(() => context.close());
  context.setDefaultTimeout(5000);
  await context.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/home')
      return route.fulfill({
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
        },
      });
    if (url.pathname === '/api/shiur')
      return route.fulfill({
        json: {
          id: 900001,
          title: 'Swipe dismissal regression recording',
          teacher: 'Test teacher',
          teacherId: 1,
          image: '',
          audio: '',
          url: origin,
          date: '2026-10-01',
          duration: 120,
          topics: [],
          category: 'Test',
          language: 'EN',
          seriesId: 0,
          series: '',
          description: 'A long description to test native scrolling. '.repeat(
            100,
          ),
          format: 'mp3',
          materials: [],
        },
      });
    return route.fulfill({
      json: { items: [], teachers: [], series: [], topics: [], partial: false },
    });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/?shiur=900001`, { waitUntil: 'domcontentloaded' });
  const sheet = page.getByRole('dialog', {
    name: 'Shiur details',
    exact: true,
  });
  await sheet.waitFor();
  await sheet.locator('.detail-hero h2').waitFor();
  await sheet.locator('.detail-description').waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const panel = document.querySelector('.detail-sheet');
    return (
      panel &&
      !panel.hasAttribute('data-starting-style') &&
      panel.getAnimations().every((a) => a.playState === 'finished')
    );
  });
  const cdp = await context.newCDPSession(page);
  async function swipe(x, y, dx, dy, cancel = false) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + (dx * i) / 12, y: y + (dy * i) / 12 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    await cdp.send('Input.dispatchTouchEvent', {
      type: cancel ? 'touchCancel' : 'touchEnd',
      touchPoints: [],
    });
  }
  return { page, sheet, swipe };
}

void test('mobile sheet dismisses on a downward swipe from the top', async (t) => {
  const { sheet, swipe } = await openSheet(t);
  const box = await sheet.boundingBox();
  await swipe(120, box.y + 90, 0, 140);
  await sheet.waitFor({ state: 'hidden' });
});

void test('short, horizontal, and canceled mobile gestures keep the sheet open', async (t) => {
  const { sheet, swipe } = await openSheet(t);
  const box = await sheet.boundingBox();
  for (const [dx, dy, cancel] of [
    [0, 35, false],
    [130, 25, false],
    [0, 140, true],
  ]) {
    await swipe(120, box.y + 90, dx, dy, cancel);
    assert.ok(await sheet.isVisible());
    assert.equal(await sheet.getAttribute('data-swiping'), null);
    assert.equal(
      await sheet.evaluate((el) => el.style.getPropertyValue('--swipe-offset')),
      '',
    );
  }
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
});

void test('native content scrolling and returning to the top do not dismiss mid-gesture', async (t) => {
  const { page, sheet, swipe } = await openSheet(t);
  await sheet.getByRole('button', { name: 'Show more', exact: true }).click();
  await sheet.evaluate((el) => {
    el.scrollTop = 0;
  });
  assert.ok(await sheet.evaluate((el) => el.scrollHeight > el.clientHeight));
  await swipe(10, 650, 0, -300);
  await page.waitForFunction(
    () => document.querySelector('.detail-sheet').scrollTop > 0,
  );
  assert.ok(await sheet.isVisible());
  await sheet.evaluate((el) => {
    el.scrollTop = 50;
  });
  await swipe(10, 350, 0, 200);
  assert.ok(await sheet.isVisible());
  assert.equal(await sheet.evaluate((el) => el.scrollTop), 0);
  const box = await sheet.boundingBox();
  await swipe(120, box.y + 90, 0, 140);
  await sheet.waitFor({ state: 'hidden' });
});

void test('desktop sheet ignores touch swipes and still closes with the button', async (t) => {
  const { sheet, swipe } = await openSheet(t, 1280);
  const box = await sheet.boundingBox();
  await swipe(box.x + 120, box.y + 90, 0, 140);
  assert.ok(await sheet.isVisible());
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
});
