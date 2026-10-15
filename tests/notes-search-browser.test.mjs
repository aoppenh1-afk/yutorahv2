import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:3036';
let browser, server, state;
before(async () => {
  if (!process.env.TEST_ORIGIN) {
    state = await mkdtemp(join(tmpdir(), 'yutorah-notes-browser-'));
    server = spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '--config',
        'dist/server/wrangler.json',
        '--port',
        '3036',
        '--persist-to',
        state,
        '--inspector-port',
        '0',
      ],
      { stdio: 'ignore' },
    );
  }
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(3000) })).ok)
        break;
    } catch {}
    if (i >= 40 || (server && server.exitCode !== null))
      throw new Error('Build the website before running notes browser tests.');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  browser = await chromium.launch();
  await mkdir('outputs/notes-search', { recursive: true });
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    if (server?.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    if (state) await rm(state, { recursive: true, force: true });
  }
});
const shiur = (id) => ({
  id,
  title: 'Prayer and teshuva ' + id,
  teacher: 'Fixture teacher',
  teacherId: 1,
  audio: origin + '/fixture-audio.wav',
  image: '',
  url: origin,
  duration: 600,
  date: '2026-10-15',
  topics: [],
  category: '',
  language: 'EN',
  series: '',
  seriesId: 0,
  description: '',
  format: 'mp3',
  materials: [],
});
const snapshot = '11111111-1111-4111-8111-111111111111';
async function fixture(t, width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  context.setDefaultTimeout(7000);
  t.after(() => context.close());
  const calls = [],
    audioCalls = [],
    detailCalls = [],
    metadataCalls = [];
  const controls = {
    fail: false,
    audioFail: false,
    empty: false,
    missingMedia: false,
    metadataPending: false,
  };
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const reply = (json) => route.fulfill({ json });
    if (url.pathname === '/api/home')
      return reply({
        featured: [],
        recent: [],
        daily: [],
        series: [],
        total: 60,
        hebrewDate: '',
        daf: '',
        nach: '',
        mishna: '',
      });
    if (url.pathname === '/api/notes-search') {
      calls.push(Object.fromEntries(url.searchParams));
      if (controls.fail)
        return route.fulfill({
          status: 503,
          json: {
            error:
              'Written notes search is being refreshed. Please try again later.',
          },
        });
      const page = Number(url.searchParams.get('page'));
      const query = url.searchParams.get('q');
      if (query === 'late')
        await new Promise((resolve) => setTimeout(resolve, 500));
      return reply({
        items: (controls.empty ? [] : page === 1 ? [1, 2] : [3]).map((id) => ({
          shiur: { ...shiur(id), title: `${query} fixture ${id}` },
          excerpt: `A written explanation of ${query} and teshuva. שלום תשובה`,
          notesHash: 'a'.repeat(64),
          href: '/?shiur=' + id,
        })),
        total: controls.empty ? 0 : 3,
        nextPage: !controls.empty && page === 1 ? 2 : null,
        snapshot,
        updatedAt: Date.now(),
      }).catch(() => {});
    }
    if (url.pathname === '/api/transcript-search') {
      audioCalls.push(Object.fromEntries(url.searchParams));
      if (controls.audioFail)
        return route.fulfill({
          status: 503,
          json: { error: 'Audio search is unavailable.' },
        });
      const query = url.searchParams.get('q');
      if (query === 'late')
        await new Promise((resolve) => setTimeout(resolve, 500));
      return reply({
        results: (controls.empty ? [] : [1, 4, 1]).map((id, index) => ({
          shiurId: String(id),
          title: `${query} audio fixture ${id}`,
          teacher: 'Fixture teacher',
          mediaUrl: controls.missingMedia ? null : shiur(id).audio,
          startMs: index === 2 ? 90000 : 12000,
          endMs: 94000,
          text: `An audio explanation of ${query}. שלום תשובה`,
          matched: query,
          aliasesExpanded: false,
          href: '/?shiur=' + id + '&t=12',
        })),
      }).catch(() => {});
    }
    if (url.pathname === '/api/search') {
      metadataCalls.push(Object.fromEntries(url.searchParams));
      return reply({
        items: [shiur(1)],
        total: 1,
        sourceTotal: 60,
        scanned: 60,
        complete: !controls.metadataPending,
        run: controls.metadataPending ? 'pending-fixture' : undefined,
        retryAfterMs: controls.metadataPending ? 60_000 : undefined,
        nextPage: null,
        notesSnapshot: url.searchParams.get('notesOnly') ? snapshot : undefined,
        plan: {
          term: 'prayer',
          original: 'prayer',
          labels: [],
          max: 0,
          language: '',
          format: '',
          teacherId: 0,
          teacherName: '',
          seriesId: 0,
          seriesName: '',
          topicId: 0,
          notesOnly: url.searchParams.get('notesOnly') === '1',
        },
        facets: { teachers: [], topics: [], series: [] },
      });
    }
    if (url.pathname === '/api/shiur') {
      detailCalls.push(url.searchParams.get('id'));
      return reply(shiur(Number(url.searchParams.get('id'))));
    }
    if (url.pathname === '/api/study-notes')
      return reply({
        status: 'completed',
        markdown:
          '# Completed written notes\n\nPrayer and teshuva belong together.',
        notesHash: 'a'.repeat(64),
      });
    if (url.pathname === '/api/transcript')
      return route.fulfill({ status: 404, json: { error: 'No transcript' } });
    if (url.pathname === '/api/transcript-status')
      return reply({ status: 'missing' });
    if (url.pathname === '/api/official-study')
      return reply({ chapters: [], summaries: [] });
    return reply({
      items: [],
      teachers: [],
      topics: [],
      series: [],
      venues: [],
      collections: [],
      partial: false,
    });
  });
  const samples = 8000 * 30;
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
  await context.route('**/fixture-audio.wav', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: wav }),
  );
  return {
    page: await context.newPage(),
    calls,
    audioCalls,
    detailCalls,
    metadataCalls,
    controls,
  };
}

const regionFor = (page) =>
  page.getByRole('region', { name: 'Search inside the shiur', exact: true });
const paused = (page) =>
  page.evaluate(
    () =>
      !document.querySelector('audio') ||
      document.querySelector('audio').paused,
  );
async function shown(page, count) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('.inside-shiur-search .shiur-row').length ===
      count,
    count,
  );
}
async function selectMatch(page, option) {
  const mode =
    option === 'Exact phrase'
      ? 'phrase'
      : option === 'Flexible audio'
        ? 'smart'
        : 'terms';
  const notesResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/notes-search' &&
      url.searchParams.get('mode') === (mode === 'smart' ? 'terms' : mode)
    );
  });
  const audioResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/transcript-search' &&
      url.searchParams.get('mode') === mode
    );
  });
  await regionFor(page)
    .getByRole('combobox', { name: 'Match inside the shiur', exact: true })
    .click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await Promise.all([notesResponse, audioResponse]);
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
}
async function rowStyles(row) {
  return row.evaluate((element) => {
    const style = getComputedStyle(element);
    const art = element.querySelector('.row-cover, .mobile-row-art');
    return {
      padding: style.padding,
      gap: style.gap,
      columns: style.gridTemplateColumns,
      art: [art.clientWidth, art.clientHeight],
    };
  });
}
for (const width of [320, 390, 1280]) {
  void test(`Inside the Shiur combines sources, paginates, and opens full details at ${width}px`, async (t) => {
    const { page, calls, audioCalls, metadataCalls } = await fixture(t, width);
    await page.goto(origin + '/?view=search&q=prayer', {
      waitUntil: 'domcontentloaded',
    });
    const regular = page.locator('.results-list .shiur-row').first();
    await regular.waitFor();
    const regularStyle = await rowStyles(regular);
    await page.screenshot({
      path: `outputs/notes-search/regular-search-${width}.png`,
      fullPage: true,
    });
    metadataCalls.length = 0;
    // Results and scope controls load in independent Suspense boundaries.
    // Hold the scope chunk until results render to reproduce the CI ordering.
    let releaseScope = () => {};
    if (width === 320) {
      const scopeReady = new Promise((resolve) => {
        releaseScope = resolve;
      });
      t.after(() => releaseScope());
      await page.route('**/search-scope-*.js', async (route) => {
        await scopeReady;
        await route.continue().catch(() => {});
      });
    }
    await page.goto(origin + '/?view=search&q=prayer&searchIn=inside', {
      waitUntil: 'domcontentloaded',
    });
    const region = regionFor(page);
    await shown(page, 3);
    releaseScope();
    await page
      .getByRole('button', { name: 'Inside the Shiur', exact: true })
      .waitFor();
    assert.equal(await page.locator('.search-scope button').count(), 2);
    assert.equal(
      metadataCalls.length,
      0,
      'Content searches must not start a metadata crawl',
    );
    assert.equal(audioCalls.length, 1);
    const shared = region.locator('.shiur-row[data-shiur-id="1"]');
    assert.equal(
      await shared.count(),
      1,
      'Notes and audio from the same shiur share a result',
    );
    await shared
      .locator('.shiur-match-source')
      .filter({ hasText: /Notes.*Audio 0:12/ })
      .waitFor();
    assert.equal(await shared.locator('.shiur-match-excerpts').count(), 1);
    assert.ok((await shared.locator('mark').count()) > 0);
    assert.deepEqual(
      await rowStyles(shared),
      regularStyle,
      'Use the same row layout as regular search',
    );
    assert.equal(await region.locator('.transcript-hit').count(), 0);
    await region
      .locator('.shiur-row[data-shiur-id="4"] h3 button')
      .filter({ hasText: 'Prayer and teshuva 4' })
      .waitFor();
    await region
      .getByRole('button', { name: 'Load more shiurim', exact: true })
      .click();
    await shown(page, 4);
    assert.equal(calls[1].snapshot, snapshot);
    await selectMatch(page, 'Exact phrase');
    await shown(page, 3);
    assert.equal(calls.at(-1).page, '1');
    assert.equal(calls.at(-1).mode, 'phrase');
    assert.equal(audioCalls.at(-1).mode, 'phrase');
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: `outputs/notes-search/inside-shiur-${width}.png`,
      fullPage: true,
    });
    await region.locator('.shiur-row[data-shiur-id="2"] h3 button').click();
    const detail = page.getByRole('dialog', {
      name: 'Shiur details',
      exact: true,
    });
    await detail.getByRole('button', { name: 'Listen', exact: true }).waitFor();
    await detail
      .getByText('Completed written notes', { exact: true })
      .waitFor();
    assert.equal(await paused(page), true);
    if (width === 390) {
      await detail.getByRole('button', { name: 'Listen', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('audio') &&
          !document.querySelector('audio').paused,
      );
    }
  });
}
for (const width of [390, 1280]) {
  void test(`inside results retain regular save, queue and playback controls at ${width}px`, async (t) => {
    const { page } = await fixture(t, width);
    await page.goto(origin + '/?view=search&q=prayer&searchIn=inside', {
      waitUntil: 'domcontentloaded',
    });
    await shown(page, 3);
    const row = regionFor(page).locator('.shiur-row[data-shiur-id="1"]');
    if (width < 768) {
      await row
        .getByRole('button', {
          name: 'More options: prayer fixture 1',
          exact: true,
        })
        .click();
      await page
        .getByRole('button', { name: 'Save for later', exact: true })
        .click();
      await row.getByLabel('Saved', { exact: true }).waitFor();
    } else {
      const save = row.getByRole('button', {
        name: 'Save prayer fixture 1',
        exact: true,
      });
      await save.click();
      assert.equal(
        await row
          .getByRole('button', { name: 'Unsave prayer fixture 1', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      );
    }
    await row
      .getByRole('button', {
        name: 'More options: prayer fixture 1',
        exact: true,
      })
      .click();
    await page
      .getByRole('button', {
        name: /Add to (listening )?queue/,
      })
      .click();
    await page
      .getByRole('status')
      .filter({ hasText: 'Added to your queue.' })
      .waitFor();
    await row.locator('.row-play, .mobile-row-play').click();
    await page.waitForFunction(
      () =>
        document.querySelector('audio') &&
        !document.querySelector('audio').paused,
    );
  });
}
for (const missingMedia of [false, true]) {
  void test(`audio-only matches open full details without autoplay, media missing=${missingMedia}`, async (t) => {
    const { page, controls, detailCalls } = await fixture(t, 390);
    controls.missingMedia = missingMedia;
    await page.goto(origin + '/?view=search&q=prayer&searchIn=inside', {
      waitUntil: 'domcontentloaded',
    });
    await shown(page, 3);
    await regionFor(page)
      .locator('.shiur-row[data-shiur-id="4"] h3 button')
      .click();
    const detail = page.getByRole('dialog', {
      name: 'Shiur details',
      exact: true,
    });
    await detail.getByRole('button', { name: 'Listen', exact: true }).waitFor();
    await detail.getByText('Prayer and teshuva 4', { exact: true }).waitFor();
    assert.ok(detailCalls.includes('4'));
    assert.equal(new URL(page.url()).searchParams.get('shiur'), '4');
    assert.equal(new URL(page.url()).searchParams.has('t'), false);
    assert.equal(await paused(page), true);
    await detail.getByRole('button', { name: 'Listen', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('audio') &&
        !document.querySelector('audio').paused,
    );
  });
}
void test('source outages keep other matches visible, retry, and reject stale results from both sources', async (t) => {
  const { page, controls, calls, audioCalls } = await fixture(t, 390);
  controls.fail = true;
  await page.goto(origin + '/?view=search&q=prayer&searchIn=inside', {
    waitUntil: 'domcontentloaded',
  });
  const region = regionFor(page);
  await region.getByRole('alert').waitFor();
  await shown(page, 2);
  controls.fail = false;
  await region.getByRole('button', { name: 'Try again', exact: true }).click();
  await shown(page, 3);
  const input = page.locator('#main-search');
  await input.fill('late');
  await input.press('Enter');
  await input.fill('teshuva');
  await input.press('Enter');
  await region.getByText('teshuva fixture 1', { exact: true }).waitFor();
  await page.waitForTimeout(600);
  assert.equal(await region.getByText(/late (audio )?fixture/).count(), 0);
  controls.audioFail = true;
  await selectMatch(page, 'Flexible audio');
  await region.getByRole('alert').waitFor();
  await shown(page, 2);
  assert.equal(calls.at(-1).mode, 'terms');
  assert.equal(audioCalls.at(-1).mode, 'smart');
  assert.equal(
    await region
      .getByText(/No audio transcripts or written notes match/)
      .count(),
    0,
  );
  controls.audioFail = false;
  await region.getByRole('button', { name: 'Try again', exact: true }).click();
  await shown(page, 3);
  controls.empty = true;
  await input.fill('unmatched');
  await input.press('Enter');
  await region
    .getByText(/No audio transcripts or written notes match/)
    .waitFor();
});
for (const scope of ['inside', 'audio', 'notes']) {
  void test(`empty ${scope} links preserve the combined scope through history`, async (t) => {
    const { page, calls, audioCalls, metadataCalls } = await fixture(t, 390);
    await page.goto(origin + '/?view=search&searchIn=' + scope, {
      waitUntil: 'domcontentloaded',
    });
    const region = regionFor(page);
    await region
      .getByText('Type a word or phrase above and press Enter.')
      .waitFor();
    assert.equal(calls.length + audioCalls.length, 0);
    const input = page.getByRole('combobox', {
      name: 'Search inside the shiur',
      exact: true,
    });
    await input.fill('teshuva');
    await input.press('Enter');
    await region.getByText('teshuva fixture 1', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('searchIn'), 'inside');
    await page.goBack();
    await region
      .getByText('Type a word or phrase above and press Enter.')
      .waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal(metadataCalls.length, 0);
  });
}
void test('returning from Inside the Shiur resumes interrupted metadata search and uses the latest query', async (t) => {
  const { page, controls, metadataCalls } = await fixture(t, 1280);
  controls.metadataPending = true;
  await page.goto(origin + '/?view=search&q=prayer', {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('.results-heading').waitFor();
  await page
    .getByRole('button', { name: 'Inside the Shiur', exact: true })
    .click();
  const region = regionFor(page);
  await shown(page, 3);
  controls.metadataPending = false;
  const resumedSearch = page.waitForResponse(
    (response) => response.url().includes('/api/search?') && response.ok(),
  );
  await page.locator('.search-scope button').first().click();
  await resumedSearch;
  assert.equal(metadataCalls.length, 2);
  await page
    .getByRole('button', { name: 'Inside the Shiur', exact: true })
    .click();
  const input = page.getByRole('combobox', {
    name: 'Search inside the shiur',
    exact: true,
  });
  await input.fill('teshuva');
  await input.press('Enter');
  await region.getByText('teshuva fixture 1', { exact: true }).waitFor();
  const nextSearch = page.waitForResponse(
    (response) => response.url().includes('/api/search?') && response.ok(),
  );
  await page.locator('.search-scope button').first().click();
  await nextSearch;
  assert.equal(metadataCalls.at(-1).q, 'teshuva');
});

void test('available-notes refinement reaches the server, persists in the URL and has a removable chip', async (t) => {
  const { page, metadataCalls } = await fixture(t, 390);
  await page.goto(origin + '/?view=search&q=prayer', {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('button', { name: 'Shiurim', exact: false }).waitFor();
  await page
    .locator('summary')
    .filter({ hasText: 'Filters & saved searches' })
    .click();
  await page.getByRole('button', { name: 'Refine', exact: false }).click();
  await page
    .getByRole('checkbox', { name: 'Written notes available', exact: true })
    .check();
  await page
    .getByRole('button', { name: 'Apply & search', exact: true })
    .click();
  await page.waitForURL('**notesOnly=1**');
  const chip = page.getByRole('button', {
    name: 'Remove filter: Written notes available',
    exact: true,
  });
  await chip.waitFor();
  assert.equal(metadataCalls.at(-1).notesOnly, '1');
  await chip.click();
  await page.waitForFunction(
    () => !new URL(location.href).searchParams.has('notesOnly'),
  );
  assert.equal(await chip.count(), 0);
});
