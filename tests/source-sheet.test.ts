import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderSourceSheet, type SheetLanguage } from '../lib/source-sheet';
import type { TranscriptSource } from '../lib/sources';
import type { SourceText } from '../lib/sefaria';

const sources: TranscriptSource[] = ['Genesis 1:1', 'Genesis 1:2'].map(
  (ref) => ({
    ref,
    heRef: 'בראשית א׳',
    url: `https://www.sefaria.org/${ref.replaceAll(' ', '_')}`,
    category: 'Tanakh / Torah',
    occurrences: [
      {
        offset: 0,
        startMs: 90000,
        endMs: 95000,
        mention: 'Transcript commentary that should stay off the sheet.',
        spans: [],
      },
    ],
  }),
);
const texts: Record<string, SourceText> = Object.fromEntries(
  sources.map((source) => [
    source.ref,
    {
      ref: source.ref,
      categories: ['Tanakh', 'Torah'],
      editions: [
        {
          language: 'he',
          direction: 'rtl',
          title: 'Original edition',
          license: 'Public Domain',
          versionSource: 'https://example.org/original',
          text: ['מקור בעברית'],
          truncated: false,
        },
        {
          language: 'en',
          direction: 'ltr',
          title: 'Translation edition',
          license: 'CC-BY',
          versionSource: 'https://example.org/translation',
          text: ['First translated paragraph.', 'Second translated paragraph.'],
          truncated: true,
        },
      ],
    } satisfies SourceText,
  ]),
);
const options = {
  shiurId: 42,
  title: 'Learning together',
  teacher: 'Test teacher',
  origin: 'https://example.org',
  sources,
  texts,
  language: 'both' as SheetLanguage,
};

void test('source sheet lays out bilingual passages, keeps every paragraph, and omits edition footnotes', async () => {
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {},
  );
  try {
    const page = await browser.newPage({
      viewport: { width: 816, height: 1056 },
    });
    for (const language of ['both', 'en', 'he'] as SheetLanguage[]) {
      await page.setContent(renderSourceSheet({ ...options, language }));
      const text = await page.locator('body').innerText();
      assert.doesNotMatch(
        text,
        /Transcript commentary|Tanakh|Mentioned at|1:30/,
      );
      assert.equal(await page.locator('article').count(), 2);
      assert.equal(await page.locator('footer').count(), 0);
      assert.doesNotMatch(
        text,
        /Text editions|Original edition|Translation edition|CC-BY|Edition source/,
      );
      if (language !== 'he') {
        assert.equal(
          await page
            .getByText('Second translated paragraph.', { exact: true })
            .count(),
          2,
        );
      }
      if (language === 'both') {
        const english = await page.locator('td[dir=ltr]').first().boundingBox();
        const hebrew = await page.locator('td[dir=rtl]').first().boundingBox();
        assert.ok(
          english && hebrew && english.x + english.width <= hebrew.x + 1,
        );
        assert.equal(
          english.y,
          hebrew.y,
          'paired passages start on the same line',
        );
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(renderSourceSheet(options));
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.setContent(renderSourceSheet({ ...options, texts: {} }));
    assert.equal(
      await page
        .getByText('Text unavailable in this language.', { exact: false })
        .count(),
      2,
    );
    assert.equal(await page.locator('footer').count(), 0);
  } finally {
    await browser.close();
  }
});

void test('long source PDFs paginate without losing passages or adding blank pages', async () => {
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {},
  );
  try {
    const page = await browser.newPage();
    const longText: SourceText = {
      ...texts[sources[0].ref],
      editions: texts[sources[0].ref].editions.map((edition) => ({
        ...edition,
        truncated: false,
        text:
          edition.language === 'en'
            ? [
                ...Array.from(
                  { length: 12 },
                  (_, i) =>
                    `Passage${i} ${'A paragraph of source text for learning together. '.repeat(12)} End${i}.`,
                ),
                `LongStart ${'This passage is longer than a printed page. '.repeat(240)} LongEnd.`,
              ]
            : Array.from({ length: 12 }, () =>
                'מקור בעברית ללימוד משותף. '.repeat(8),
              ),
      })),
    };
    await page.setContent(
      renderSourceSheet({
        ...options,
        texts: { ...texts, [sources[0].ref]: longText },
        extent: 'full',
      }),
    );
    const bytes = await page.pdf({ format: 'A4', displayHeaderFooter: false });
    const loadingTask = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    });
    const document = await loadingTask.promise;
    try {
      assert.ok(document.numPages > 1, 'fixture exercises page breaks');
      const pages = [];
      const links: string[] = [];
      for (let i = 1; i <= document.numPages; i++) {
        const pdfPage = await document.getPage(i);
        const content = await pdfPage.getTextContent();
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ');
        assert.ok(text.trim().length > 50, `page ${i} is not blank`);
        pages.push(text);
        links.push(
          ...(await pdfPage.getAnnotations())
            .map((annotation) => annotation.url)
            .filter(Boolean),
        );
      }
      const text = pages.join(' ');
      for (let i = 0; i < 12; i++) {
        assert.ok(
          text.includes(`Passage${i}`) && text.includes(`End${i}.`),
          `passage ${i} survives pagination`,
        );
      }
      assert.match(text, /LongStart/);
      assert.match(text, /LongEnd/);
      assert.match(text, /Genesis 1:2/);
      assert.doesNotMatch(
        text,
        /Text editions|Original edition|Translation edition|CC-BY|Edition source/,
      );
      assert.doesNotMatch(text, /Transcript commentary|Mentioned at|Tanakh/);
      assert.ok(
        links.some((url) => url.startsWith('https://www.sefaria.org/')),
      );
      assert.ok(!links.includes('https://example.org/translation'));
    } finally {
      await loadingTask.destroy();
    }
  } finally {
    await browser.close();
  }
});
