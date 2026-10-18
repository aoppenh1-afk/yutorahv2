// Run with npm run dev, or set TEST_ORIGIN to an existing app server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.TEST_ORIGIN || 'http://localhost:5173';
const items = Array.from({ length: 80 }, (_, index) => ({
  id: 900000 + index,
  title: `Daf recording ${index + 1}`,
  teacher: 'Test teacher',
  teacherId: 1,
  image: '',
  audio: '',
  url: origin,
  date: '2026-10-01',
  duration: 120,
  topics: [],
  category: 'Gemara',
  language: 'EN',
  series: '',
  seriesId: 0,
  description: '',
  format: 'mp3',
  materials: [],
}));

void test('Daf recordings scroll beside the scan and stay reachable on mobile', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    await page.route('**/api/**', (route) => {
      const url = new URL(route.request().url());
      if (
        url.pathname === '/api/catalog' &&
        url.searchParams.get('action') === 'daf'
      )
        return route.fulfill({
          json: {
            tractate: 'Berachot',
            page: 2,
            side: 'a',
            image: '/test-daf.svg',
            items,
            related: [
              { ...items[0], id: 999999, title: 'Related learning fixture' },
            ],
            tractates: [],
          },
        });
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
            fetchedAt: '',
          },
        });
      return route.fulfill({
        json: {
          items: [],
          teachers: [],
          series: [],
          topics: [],
          partial: false,
        },
      });
    });
    await page.route('**/test-daf.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1400"><rect width="800" height="1400" fill="#faf5e9"/></svg>',
      }),
    );
    await page.goto(`${origin}/?view=daf&tractate=Berachot&page=2&side=a`);
    await page.locator('.daf-recordings .shiur-row').first().waitFor();
    await page.waitForFunction(
      () => document.querySelector('.daf-scan img')?.naturalWidth > 0,
    );

    // A long list must not determine the height of either desktop column.
    for (const width of [1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 900 });
      const dimensions = await page.evaluate(() => {
        const scan = document.querySelector('.daf-scan');
        const recordings = document.querySelector('.daf-recordings');
        const list =
          document.querySelector('.daf-recordings-list') || recordings;
        list.scrollTop = 0;
        const before = {
          y: window.scrollY,
          scanTop: scan.getBoundingClientRect().top,
        };
        list.scrollTop = 300;
        return {
          scanHeight: scan.getBoundingClientRect().height,
          recordingsHeight: recordings.getBoundingClientRect().height,
          listScroll: list.scrollTop,
          pageMoved: window.scrollY !== before.y,
          scanMoved: scan.getBoundingClientRect().top !== before.scanTop,
        };
      });
      assert.ok(
        dimensions.recordingsHeight < 900,
        `bounded panels at ${width}px`,
      );
      assert.ok(
        Math.abs(dimensions.scanHeight - dimensions.recordingsHeight) < 2,
      );
      assert.ok(
        dimensions.listScroll > 0,
        'recordings have their own scrollbar',
      );
      assert.equal(dimensions.pageMoved, false);
      assert.equal(dimensions.scanMoved, false);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    const list = page.locator('.daf-recordings-list');
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await list.hover();
    const pageBeforeWheel = await page.evaluate(() => ({
      y: window.scrollY,
      scanTop: document.querySelector('.daf-scan').getBoundingClientRect().top,
      headingTop: document
        .querySelector('.daf-recordings h2')
        .getBoundingClientRect().top,
    }));
    await page.mouse.wheel(0, 250);
    await page.waitForFunction(
      () => document.querySelector('.daf-recordings-list').scrollTop > 0,
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        y: window.scrollY,
        scanTop: document.querySelector('.daf-scan').getBoundingClientRect()
          .top,
        headingTop: document
          .querySelector('.daf-recordings h2')
          .getBoundingClientRect().top,
      })),
      pageBeforeWheel,
    );
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await list.focus();
    await page.keyboard.press('PageDown');
    await page.waitForFunction(
      () => document.querySelector('.daf-recordings-list').scrollTop > 0,
    );
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page
      .getByRole('navigation', { name: 'List pages' })
      .getByRole('button', { name: 'Next', exact: true })
      .click();
    await page.getByText('Daf recording 61', { exact: true }).waitFor();
    await page
      .getByText('Related learning fixture', { exact: true })
      .scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Enlarge daf' }).click();
    await page.waitForFunction(() => {
      const scan = document.querySelector('.daf-scan');
      return scan.scrollWidth > scan.clientWidth;
    });
    await page.getByRole('button', { name: 'Fit page' }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
      const scan = document.querySelector('.daf-scan').getBoundingClientRect();
      const recordings = document
        .querySelector('.daf-recordings')
        .getBoundingClientRect();
      const list = document.querySelector('.daf-recordings-list');
      return {
        stacked: recordings.top >= scan.bottom,
        listOverflow: getComputedStyle(list).overflowY,
        pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    assert.equal(mobile.stacked, true);
    assert.equal(mobile.listOverflow, 'visible');
    assert.equal(mobile.pageOverflows, false);
  } finally {
    await browser.close();
  }
});
