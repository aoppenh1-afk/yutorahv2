import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { pageCollection, collectionNeighbors } from '../lib/catalog-pages';
import { normalize } from '../lib/yutorah';
import { restoreLibrary } from '../lib/library';
import type { CollectionData } from '../lib/catalog';

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:3018';
const state = process.env.TEST_ORIGIN
  ? null
  : await mkdtemp(join(tmpdir(), 'yutorah-catalog-browser-'));
const server = state
  ? spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '--config',
        'dist/server/wrangler.json',
        '--port',
        '3018',
        '--inspector-port',
        '0',
        '--persist-to',
        state,
      ],
      { stdio: 'ignore' },
    )
  : null;
for (let attempt = 0; ; attempt++) {
  try {
    if ((await fetch(origin, { signal: AbortSignal.timeout(3000) })).ok) break;
  } catch {}
  if (attempt >= 30 || (server && server.exitCode !== null)) {
    server?.kill();
    if (state) await rm(state, { recursive: true, force: true });
    throw new Error(
      'Build the application before running catalog browser regressions.',
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
const browser = await chromium.launch();
test.after(async () => {
  await browser.close();
  server?.kill();
  if (state) await rm(state, { recursive: true, force: true });
});
const version = 'f'.repeat(64);
const collection: CollectionData = {
  id: 42,
  name: 'Collection fixture',
  count: 121,
  description: '',
  image: '',
  updatedAt: '',
  related: [],
  items: Array.from({ length: 121 }, (_, i) =>
    normalize({
      shiurID: i + 1,
      shiurTitle: i === 120 ? 'A final unique lesson' : `Lesson ${i + 1}`,
      shiurDate: new Date(Date.UTC(2020, 0, i + 1)).toISOString(),
      shiurFileURL: `${origin}/fixture.wav`,
    }),
  ),
};
async function fixtures(context: BrowserContext) {
  const requests: URL[] = [];
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname === '/api/catalog') {
      if (url.searchParams.get('action') === 'entity')
        return route.fulfill({
          json: pageCollection(collection, version, {
            offset: Number(url.searchParams.get('offset') || 0),
            query: url.searchParams.get('q') || '',
            order: (url.searchParams.get('sort') || 'old') as
              | 'old'
              | 'new'
              | 'title',
          }),
        });
      if (url.searchParams.get('action') === 'neighbors')
        return route.fulfill({
          json: collectionNeighbors(
            collection,
            version,
            Number(url.searchParams.get('shiur')),
          ),
        });
      return route.fulfill({ json: { entries: [], total: 0, next: null } });
    }
    if (url.pathname === '/api/home')
      return route.fulfill({
        json: {
          featured: [],
          recent: [],
          daily: [],
          recentlyViewed: [],
          series: [],
          total: 0,
          hebrewDate: '',
          fetchedAt: '',
        },
      });
    if (url.pathname === '/api/directory')
      return route.fulfill({
        json: { teachers: [], series: [], topics: [], groups: [] },
      });
    if (url.pathname === '/api/shiur-views')
      return route.fulfill({ json: { views: {} } });
    if (url.pathname === '/api/catalog-artwork')
      return route.fulfill({ json: { image: '' } });
    return route.fulfill({
      json: {
        items: [],
        segments: [],
        status: 'unavailable',
        available: false,
        chapters: [],
        summary: '',
      },
    });
  });
  return requests;
}
void test(
  'collection pages keep global filtering and ordering, and Add all loads every lesson',
  { timeout: 30_000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const requests = await fixtures(context);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(origin + '/?view=collection&kind=collection&id=42');
      await page.getByRole('heading', { name: 'Collection fixture' }).waitFor();
      assert.equal(await page.locator('.shiur-row').count(), 60);
      await page
        .getByRole('navigation', { name: 'Collection pages' })
        .getByRole('button', { name: 'Next' })
        .click();
      await page
        .locator('.shiur-row')
        .filter({ hasText: 'Lesson 61' })
        .waitFor();
      const next = requests
        .filter((u) => u.searchParams.get('offset') === '60')
        .at(-1)!;
      assert.equal(next.searchParams.get('version'), version);
      await page
        .getByRole('searchbox', { name: 'Find in this collection' })
        .fill('unique');
      await page
        .locator('.shiur-row')
        .filter({ hasText: 'A final unique lesson' })
        .waitFor();
      assert.equal(await page.locator('.shiur-row').count(), 1);
      await page
        .getByRole('searchbox', { name: 'Find in this collection' })
        .fill('');
      await page.getByRole('combobox', { name: 'Collection order' }).click();
      await page.getByRole('option', { name: 'Title A–Z' }).click();
      await page.waitForFunction(() =>
        document
          .querySelector('.shiur-row')
          ?.textContent?.includes('A final unique lesson'),
      );
      await page
        .getByRole('button', { name: 'More collection actions' })
        .click();
      await page
        .getByRole('button', { name: 'Add all to queue', exact: true })
        .click();
      await page
        .getByText('Collection added to queue.', { exact: true })
        .waitFor();
      await page.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem('yutorah-learning-v1') || '{}').queue
            ?.length === 121,
      );
      const queued = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('yutorah-learning-v1') || '{}').queue,
      );
      assert.deepEqual(
        queued,
        collection.items.map((s) => s.id),
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);
void test(
  'Home reuses its preload for the initial data request',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext();
    await fixtures(context);
    let calls = 0;
    await context.route('**/api/home', (route) => {
      calls++;
      return route.fulfill({
        json: {
          featured: [collection.items[0]],
          recent: [],
          daily: [],
          recentlyViewed: [],
          series: [],
          total: 1,
          hebrewDate: '',
          fetchedAt: '',
        },
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      await page.goto(origin);
      await page
        .getByText('Lesson 1', { exact: true })
        .first()
        .waitFor({ state: 'attached' });
      assert.equal(
        calls,
        1,
        'The browser should reuse the preloaded public response.',
      );
    } finally {
      await context.close();
    }
  },
);
void test(
  'collection search keeps its input and caret while requests are pending and results arrive',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext();
    const requests = await fixtures(context);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await context.route('**/api/catalog?*', async (route) => {
      const url = new URL(route.request().url());
      if (
        url.searchParams.get('action') === 'entity' &&
        url.searchParams.get('q') === 'uni'
      )
        await held;
      return route.fallback();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      await page.goto(origin + '/?view=collection&kind=collection&id=42');
      await page.getByRole('heading', { name: 'Collection fixture' }).waitFor();
      const input = page.getByRole('searchbox', {
        name: 'Find in this collection',
      });
      await input.click();
      const original = await input.elementHandle();
      assert.ok(original);
      const pending = page.waitForRequest(
        (request) => new URL(request.url()).searchParams.get('q') === 'uni',
      );
      await input.pressSequentially('uni', { delay: 40 });
      await pending;
      assert.equal(
        await original.evaluate((node) => node.isConnected),
        true,
        'Searching must not remove the focused input.',
      );
      assert.equal(
        await original.evaluate((node) => document.activeElement === node),
        true,
      );
      const updated = page.waitForResponse(
        (response) => new URL(response.url()).searchParams.get('q') === 'uniq',
      );
      await page.keyboard.type('q');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      release();
      await updated;
      await page
        .locator('.shiur-row')
        .filter({ hasText: 'A final unique lesson' })
        .waitFor();
      assert.equal(
        await original.evaluate(
          (node) => node.isConnected && document.activeElement === node,
        ),
        true,
      );
      assert.equal(await input.inputValue(), 'uniq');
      assert.equal(
        await input.evaluate((node: HTMLInputElement) => node.selectionStart),
        2,
      );
      assert.deepEqual(
        requests
          .filter(
            (url) =>
              url.searchParams.get('action') === 'entity' &&
              url.searchParams.get('q'),
          )
          .map((url) => url.searchParams.get('q')),
        ['uni', 'uniq'],
      );
      assert.equal(
        page.url(),
        origin + '/?view=collection&kind=collection&id=42',
      );
    } finally {
      release();
      await context.close();
    }
  },
);
void test(
  'whole collection actions report a full queue without claiming success or truncating it',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext();
    await fixtures(context);
    const library = restoreLibrary(null);
    library.queue = Array.from({ length: 970 }, (_, i) => ({
      ...collection.items[0],
      id: 50000 + i,
    }));
    await context.addInitScript(
      (value) =>
        localStorage.setItem('yutorah-learning-v1', JSON.stringify(value)),
      library,
    );
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      await page.goto(origin + '/?view=collection&kind=collection&id=42');
      await page.getByRole('heading', { name: 'Collection fixture' }).waitFor();
      await page
        .getByRole('button', { name: 'More collection actions' })
        .click();
      await page
        .getByRole('button', { name: 'Add all to queue', exact: true })
        .click();
      await page
        .getByText(
          'The collection could not be added. Check the available space in your queue.',
          { exact: true },
        )
        .waitFor();
      const queued = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('yutorah-learning-v1') || '{}').queue,
      );
      assert.equal(queued.length, 970);
      assert.equal(
        await page
          .getByText('Collection added to queue.', { exact: true })
          .count(),
        0,
      );
    } finally {
      await context.close();
    }
  },
);
void test(
  'Continue learning beyond the first collection page requests just its lesson neighbors',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const library = restoreLibrary(null);
    library.completed = Array.from({ length: 70 }, (_, i) => i + 1);
    await context.addInitScript(
      (value) =>
        localStorage.setItem('yutorah-learning-v1', JSON.stringify(value)),
      library,
    );
    const requests = await fixtures(context);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      await page.goto(origin + '/?view=collection&kind=collection&id=42');
      await page.getByRole('heading', { name: 'Collection fixture' }).waitFor();
      await page
        .locator('.catalog-profile')
        .getByRole('button', { name: 'Continue learning', exact: true })
        .waitFor();
      assert.ok(
        requests.some(
          (u) =>
            u.searchParams.get('action') === 'neighbors' &&
            u.searchParams.get('shiur') === '71',
        ),
      );
      assert.ok(!requests.some((u) => u.searchParams.get('offset') === '60'));
    } finally {
      await context.close();
    }
  },
);
void test(
  'a direct shiur opens playable core details while optional enrichment is stalled',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await fixtures(context);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fullStarted = false;
    const core = {
      ...collection.items[0],
      id: 777002,
      title: 'Ready to play fixture',
    };
    await context.route('**/api/shiur?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('part') !== 'core') {
        fullStarted = true;
        await ready;
      }
      await route.fulfill({
        json:
          url.searchParams.get('part') === 'core'
            ? core
            : { ...core, description: 'Optional metadata arrived' },
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      await page.goto(origin + '/?shiur=777002');
      await page
        .getByRole('heading', { name: 'Ready to play fixture' })
        .waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: 'Listen', exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(fullStarted, true);
      release();
      await page
        .getByText('Optional metadata arrived', { exact: true })
        .waitFor();
    } finally {
      release();
      await context.close();
    }
  },
);
void test(
  'an expired collection version can restart at a fresh first page',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext();
    const requests = await fixtures(context);
    let expired = false;
    await context.route('**/api/catalog?*', async (route) => {
      const url = new URL(route.request().url());
      if (
        !expired &&
        url.searchParams.get('action') === 'entity' &&
        url.searchParams.get('offset') === '60'
      ) {
        expired = true;
        return route.fulfill({
          status: 409,
          json: { error: 'This library page has updated. Reload to continue.' },
        });
      }
      return route.fallback();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      await page.goto(origin + '/?view=collection&kind=collection&id=42');
      await page.getByRole('heading', { name: 'Collection fixture' }).waitFor();
      await page
        .getByRole('navigation', { name: 'Collection pages' })
        .getByRole('button', { name: 'Next' })
        .click();
      await page
        .getByText('This collection could not load', { exact: true })
        .waitFor();
      await page
        .getByRole('button', { name: 'Try again', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Collection fixture' }).waitFor();
      assert.equal(await page.locator('.shiur-row').count(), 60);
      assert.ok(
        requests.some(
          (u) =>
            u.searchParams.get('fresh') === '1' &&
            !u.searchParams.has('version') &&
            u.searchParams.get('offset') === '0',
        ),
      );
    } finally {
      await context.close();
    }
  },
);
void test(
  'a failed Continue learning lookup offers a working retry',
  { timeout: 20_000 },
  async () => {
    const context = await browser.newContext();
    const library = restoreLibrary(null);
    library.completed = Array.from({ length: 70 }, (_, i) => i + 1);
    await context.addInitScript(
      (value) =>
        localStorage.setItem('yutorah-learning-v1', JSON.stringify(value)),
      library,
    );
    await fixtures(context);
    let attempts = 0;
    await context.route('**/api/catalog?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('action') === 'neighbors' && ++attempts === 1)
        return route.fulfill({
          status: 502,
          json: { error: 'Temporary failure' },
        });
      return route.fallback();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      await page.goto(origin + '/?view=collection&kind=collection&id=42');
      await page
        .getByRole('button', { name: 'Retry continue learning', exact: true })
        .click();
      await page
        .locator('.catalog-profile')
        .getByRole('button', { name: 'Continue learning', exact: true })
        .waitFor();
      assert.equal(attempts, 2);
    } finally {
      await context.close();
    }
  },
);
