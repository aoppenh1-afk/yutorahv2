import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Font } from '@react-pdf/renderer';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { createNotesDocx } from '../lib/notes-docx';
import {
  createNotesPdf,
  createNotesBundlePdf,
  type NotesBundleDocument,
} from '../lib/notes-pdf';
import { notesBlocks } from '../lib/notes-document';
import {
  remarkNotesDirection,
  stripNotesDirectionControls,
} from '../lib/notes-direction';

const directionExamples = [
  [
    '**גמ׳:** שמע מינה מצטמק ויפה לו מותר.',
    '\u200eגמ׳\u200e: \u200e\u200fשמע מינה מצטמק ויפה לו מותר.\u200f\u200e',
  ],
  [
    '**רב יצחק בר נחמני אמר רב אושעיא:** קטמה והובערה, משהין עליה חמין שהוחמו כל צרכן',
    '\u200eרב יצחק בר נחמני אמר רב אושעיא\u200e: \u200eקטמה והובערה, משהין עליה חמין שהוחמו כל צרכן\u200e',
  ],
  [
    '**גמ׳ (שבת דף ל״ז:-ל״ח.)**',
    '\u200e\u200fגמ׳ (שבת דף ל״ז:-ל״ח.)\u200f\u200e',
  ],
  ['**משנה (דף ל״ו:)**', '\u200e\u200fמשנה (דף ל״ו:)\u200f\u200e'],
  [
    '**חנניה:** נותנים means חזרה',
    '\u200eחנניה\u200e: \u200eנותנים\u200e means \u200eחזרה\u200e',
  ],
  ['אין **טומנין** on שבת', '\u200eאין טומנין\u200e on \u200eשבת\u200e'],
  [
    'On שבת (שלא יוסיף הבל בשבת)',
    'On \u200eשבת\u200e \u200e\u200f(שלא יוסיף הבל בשבת)\u200f\u200e',
  ],
  [
    'See גמ׳ דף לו: and compare דף לז.',
    'See \u200e\u200fגמ׳ דף לו:\u200f\u200e and compare \u200e\u200fדף לז.\u200f\u200e',
  ],
  ['English with **bold** and *italic*.', 'English with bold and italic.'],
] as const;

void test('viewer and export keep Lectern source labels before Hebrew explanations and retain whole Hebrew phrases', () => {
  for (const [source, expected] of directionExamples) {
    const exported = notesBlocks(source)[0]
      .runs.map((run) => run.text)
      .join('');
    assert.equal(exported, expected, source);
    const html = renderToStaticMarkup(
      createElement(
        Markdown,
        { remarkPlugins: [remarkNotesDirection] },
        stripNotesDirectionControls(source),
      ),
    );
    assert.equal(
      html.replace(/<[^>]*>/gu, '').replace(/&quot;/gu, '"'),
      expected,
      source,
    );
    const original = renderToStaticMarkup(createElement(Markdown, {}, source));
    assert.equal(
      stripNotesDirectionControls(html),
      original,
      'Direction formatting preserves text, emphasis, and markup',
    );
  }
});

void test('pasted direction controls are rebuilt without disturbing headings, lists, links, or hard breaks', () => {
  const source =
    '\u200f# \u202bשבת\u202c\n\n\u200e- **\u2067גמ׳\u2069:** שמע מינה  \n  תורה\n  - [רש״י](https://www.sefaria.org) on שבת\n';
  const clean = stripNotesDirectionControls(source);
  assert.deepEqual(notesBlocks(source), notesBlocks(clean));
  const blocks = notesBlocks(source);
  assert.equal(blocks[0].heading, 1);
  assert.equal(blocks[1].indent, 1);
  assert.equal(blocks[2].indent, 2);
  assert.equal(
    blocks[2].runs.find((run) => run.url)?.url,
    'https://www.sefaria.org',
  );
  assert.ok(blocks[1].runs.some((run) => run.text.includes('\n')));
  const html = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkNotesDirection] }, clean),
  );
  assert.match(html, /<h1>/u);
  assert.match(html, /<br\/>/u);
  assert.match(html, /href="https:\/\/www.sefaria.org"/u);
  assert.match(html, /\u200eגמ׳\u200e:/u);
  const hardBreak = '**גמ׳:** שמע מינה  \nתורה';
  const hardBreakHtml = renderToStaticMarkup(
    createElement(
      Markdown,
      { remarkPlugins: [remarkNotesDirection] },
      hardBreak,
    ),
  );
  assert.equal(
    hardBreakHtml.replace(/<br\/>\n?/gu, '\n').replace(/<[^>]*>/gu, ''),
    notesBlocks(hardBreak)[0]
      .runs.map((run) => run.text)
      .join(''),
  );
});

const markdown = `# Notes

English text with **bold**, *italic*, and [Genesis](https://www.sefaria.org/Genesis.1.1).

## לימוד תורה

תורה היא מקור חיים.

3. Numbered point
4. Another point
   - Nested point

[Reference][source] and [unsafe](javascript:alert).

[source]: https://www.sefaria.org/Exodus.1.1
`;

void test('notes export retains formatted content, nested lists, references, and mixed directions', () => {
  const blocks = notesBlocks(markdown);
  assert.equal(blocks[0].heading, 1);
  assert.equal(blocks[2].heading, 2);
  assert.ok(blocks[1].runs.some((run) => run.text === 'bold' && run.bold));
  assert.ok(blocks[1].runs.some((run) => run.text === 'italic' && run.italic));
  assert.ok(blocks.some((block) => block.prefix === '3. '));
  assert.ok(blocks.some((block) => block.prefix === '4. '));
  assert.ok(
    blocks.some((block) => block.prefix === '• ' && block.indent === 2),
  );
  const runs = blocks.flatMap((block) => block.runs);
  assert.equal(
    runs.find((run) => run.text === 'Reference')?.url,
    'https://www.sefaria.org/Exodus.1.1',
  );
  assert.equal(runs.find((run) => run.text === 'unsafe')?.url, undefined);
});

void test('Word download is a real DOCX with headings, emphasis, Hebrew direction, and safe hyperlinks', async () => {
  const blob = await createNotesDocx(markdown);
  assert.equal(
    blob.type,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.ok(zip.file('[Content_Types].xml'));
  const xml = await zip.file('word/document.xml')!.async('string');
  const relationships = await zip
    .file('word/_rels/document.xml.rels')!
    .async('string');
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /w:pStyle w:val="Heading2"/);
  assert.match(xml, /<w:b\/>/);
  assert.match(xml, /<w:i\/>/);
  assert.match(xml, /תורה היא מקור חיים/);
  assert.match(xml, /<w:bidi w:val="false"\/>/);
  assert.doesNotMatch(xml, /<w:bidi\/>/);
  assert.match(xml, /3\. /);
  assert.match(xml, /Nested point/);
  assert.match(relationships, /https:\/\/www.sefaria.org\/Genesis.1.1/);
  assert.match(relationships, /https:\/\/www.sefaria.org\/Exodus.1.1/);
  assert.doesNotMatch(relationships, /javascript:/);
});

const mixedNotes = `# Notes

תורה is the foundation of learning.

- **לפי תוס׳:** returning before Shabbat is discussed here.

English with תורה and learning.

- **גמ׳:** שמע מינה מצטמק ויפה לו מותר.
`;

void test('Word paragraphs keep the preview’s left-to-right layout when an English explanation starts in Hebrew', async () => {
  const blob = await createNotesDocx(mixedNotes);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('word/document.xml')!.async('string');
  const paragraphs = xml.match(/<w:p>.*?<\/w:p>/g)!;
  assert.equal(paragraphs.length, 5);
  for (const paragraph of paragraphs) {
    assert.match(paragraph, /<w:bidi w:val="false"\/>/);
    assert.match(paragraph, /<w:jc w:val="left"\/>/);
    assert.doesNotMatch(paragraph, /<w:rtl\/>/);
  }
  assert.match(paragraphs[4], /<w:b\/>.*?\u200eגמ׳\u200e:/u);
  assert.match(
    paragraphs[4],
    /\u200e\u200fשמע מינה מצטמק ויפה לו מותר\.\u200f\u200e/u,
  );
});

function registerLocalPdfFonts() {
  // Pre-register local copies so the real browser exporter also runs in Node.
  Font.register({
    family: 'NotesDisplay',
    fonts: [
      ['Regular', 400, 'normal'],
      ['Semibold', 700, 'normal'],
      ['It', 400, 'italic'],
      ['SemiboldIt', 700, 'italic'],
    ].map(([variant, fontWeight, fontStyle]) => ({
      src: fileURLToPath(
        new URL(
          `../public/fonts/notes/SourceSerif4-${variant}.ttf`,
          import.meta.url,
        ),
      ),
      fontWeight: fontWeight as 400 | 700,
      fontStyle: fontStyle as 'normal' | 'italic',
    })),
  });
  for (const [family, name] of [
    ['Notes', 'NotoSansHebrew'],
    ['NotesLatin', 'NotoSans'],
  ]) {
    Font.register({
      family,
      fonts: [
        {
          src: fileURLToPath(
            new URL(
              `../public/fonts/notes/${name}-Regular.ttf`,
              import.meta.url,
            ),
          ),
          fontWeight: 400,
        },
        {
          src: fileURLToPath(
            new URL(`../public/fonts/notes/${name}-Bold.ttf`, import.meta.url),
          ),
          fontWeight: 700,
        },
        {
          src: fileURLToPath(
            new URL(
              `../public/fonts/notes/${name}-${family === 'NotesLatin' ? 'Italic' : 'Regular'}.ttf`,
              import.meta.url,
            ),
          ),
          fontWeight: 400,
          fontStyle: 'italic',
        },
      ],
    });
  }
}

void test('PDF uses US Letter pages and keeps bold Hebrew source labels before explanations', async () => {
  registerLocalPdfFonts();
  const blob = await createNotesPdf(mixedNotes);
  const loading = getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    useSystemFonts: false,
  });
  const document = await loading.promise;
  try {
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    assert.equal(viewport.width, 612, 'US Letter width is 8.5 inches');
    assert.equal(viewport.height, 792, 'US Letter height is 11 inches');
    const content = await page.getTextContent();
    const items = content.items.filter((item) => 'str' in item);
    const hebrew = items.find((item) => item.str.includes('תורה'))!;
    const english = items.find((item) =>
      item.str.includes('is the foundation'),
    )!;
    assert.ok(hebrew, 'Hebrew text survives the export');
    assert.ok(english, 'English text survives the export');
    assert.ok(
      hebrew.transform[4] < 60,
      'Hebrew-led paragraph starts at the left margin',
    );
    assert.ok(
      hebrew.transform[4] < english.transform[4],
      'Hebrew term appears before its English explanation',
    );
    const label = items.find((item) => item.str.includes('לפי'))!;
    const explanation = items.find((item) => item.str.includes('returning'))!;
    assert.ok(label, 'Bold Hebrew label survives the export');
    assert.ok(explanation, 'List explanation survives the export');
    assert.ok(
      label.transform[4] < explanation.transform[4],
      'Bold Hebrew label stays to the left of its explanation',
    );
    assert.equal(label.transform[5], explanation.transform[5]);
    const gemara = items.find((item) => item.str.includes('גמ׳'))!;
    const hebrewExplanation = items.find((item) => item.str.includes('שמע'))!;
    assert.ok(gemara, 'Bold Gemara label survives the export');
    assert.ok(hebrewExplanation, 'Hebrew explanation survives the export');
    assert.ok(
      gemara.transform[4] < hebrewExplanation.transform[4],
      'Bold Gemara label stays on the left before a Hebrew explanation',
    );
    assert.equal(gemara.transform[5], hebrewExplanation.transform[5]);
    assert.notEqual(
      gemara.fontName,
      hebrewExplanation.fontName,
      'Only the source label uses the bold font',
    );
  } finally {
    await loading.destroy();
  }
});

void test('bundle PDF preserves notes across pages and prints contents numbers that match working destinations', async () => {
  registerLocalPdfFonts();
  const paragraphs = Array.from(
    { length: 70 },
    (_, i) =>
      `Paragraph ${String(i + 1).padStart(3, '0')}. This original explanation must remain complete and in order when the notes continue onto another page.`,
  );
  const firstTitle = 'Learning Torah';
  const bundle: NotesBundleDocument = {
    title:
      'Selected Shiurim in Halacha and Jewish Thought: Sources, Questions, and Practical Applications for the Entire Year',
    subtitle: '28 shiurim with notes',
    items: Array.from({ length: 28 }, (_, i) => ({
      id: 1000 + i,
      title:
        i === 0
          ? firstTitle
          : `Lecture ${i + 1}: a longer title about sources and practical applications that wraps onto a second line in the contents`,
      teacher: 'Rabbi Example',
      date: i % 2 ? '' : '2026-10-01',
      markdown:
        i === 0
          ? `# ${firstTitle}\n\n## Original section\n\n${paragraphs.join('\n\n')}\n\n## Final section\n\n- **גמ׳:** שמע מינה מצטמק ויפה לו מותר.\n  - **Bold explanation** with *italic emphasis* and [Genesis](https://www.sefaria.org/Genesis.1.1).`
          : `# Original note ${i + 1}\n\nUnique explanation ${i + 1} is preserved.`,
    })),
  };
  const original = structuredClone(bundle);
  const blob = await createNotesBundlePdf(bundle);
  assert.deepEqual(bundle, original, 'Export never mutates the supplied notes');
  const loading = getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(
      new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
    ),
  });
  const document = await loading.promise;
  try {
    const destinationPage = async (name: string) => {
      const destination = await document.getDestination(name);
      assert.ok(destination, `${name} has a named destination`);
      return (await document.getPageIndex(destination[0])) + 1;
    };
    assert.equal(await destinationPage('contents'), 2);
    const firstChapter = await destinationPage('shiur-1000');
    assert.ok(firstChapter > 3, 'Contents span multiple pages');
    const secondChapter = await destinationPage('shiur-1001');
    assert.ok(
      secondChapter > firstChapter + 1,
      'Long notes span multiple pages',
    );
    const outline = await document.getOutline();
    assert.deepEqual(
      outline?.map((entry) => entry.title),
      [
        'Cover',
        'Contents',
        ...bundle.items.map((item, i) => `${i + 1}. ${item.title}`),
      ],
    );

    let contentsLinks = 0;
    const originalBody: string[] = [];
    let hasSourceLink = false;
    let hasHebrewLabel = false;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      assert.equal(viewport.width, 612);
      assert.equal(viewport.height, 792);
      const content = await page.getTextContent();
      const text = content.items.filter((item) => 'str' in item);
      const annotations = await page.getAnnotations();
      if (number === 1) {
        assert.ok(
          !text.some((item) => item.str === 'Contents'),
          'Cover stands alone',
        );
        assert.ok(text.some((item) => item.str === 'Oct 1, 2026'));
        for (const item of text.filter((item) => item.str.trim())) {
          assert.ok(
            item.transform[4] >= 63 &&
              item.transform[4] + item.width <= 549 &&
              item.transform[5] >= 61 &&
              item.transform[5] <= 731,
            `Long cover title and metadata stay inside the frame: ${item.str}`,
          );
        }
        continue;
      }
      assert.ok(
        text.some((item) => item.str === 'YUTorah'),
        `Header on page ${number}`,
      );
      assert.ok(
        text.some((item) => item.str === `${number} / ${document.numPages}`),
        `Accurate footer on page ${number}`,
      );
      for (const item of text.filter((item) => item.str.trim())) {
        assert.ok(
          item.transform[4] >= 53,
          `Text stays inside the left margin on page ${number}`,
        );
        assert.ok(
          item.transform[4] + item.width <= 559,
          `Text stays inside the right margin on page ${number}`,
        );
        assert.ok(
          item.transform[5] >= 29 && item.transform[5] <= 761,
          `Text stays inside the page on page ${number}`,
        );
      }
      if (number < firstChapter) {
        assert.ok(
          text.some((item) => item.str === 'Contents'),
          'Contents heading repeats',
        );
        for (const link of annotations.filter(
          (annotation) =>
            typeof annotation.dest === 'string' &&
            annotation.dest.startsWith('shiur-'),
        )) {
          const expectedPage = await destinationPage(link.dest);
          assert.ok(
            text.some(
              (item) =>
                item.str === String(expectedPage) &&
                item.transform[4] > 520 &&
                item.transform[5] >= link.rect[1] &&
                item.transform[5] <= link.rect[3],
            ),
            `Printed contents number matches ${link.dest}`,
          );
          contentsLinks++;
        }
      } else {
        assert.ok(
          annotations.some((annotation) => annotation.dest === 'contents'),
          'Every note page links back to the first contents page',
        );
        hasSourceLink ||= annotations.some(
          (annotation) =>
            annotation.url === 'https://www.sefaria.org/Genesis.1.1',
        );
        hasHebrewLabel ||= text.some((item) => item.str.includes('גמ׳'));
        const sourceLabel = text.find((item) => item.str.includes('גמ׳'));
        if (sourceLabel) {
          const explanation = text.find((item) => item.str.includes('שמע'));
          assert.ok(
            explanation,
            'Hebrew explanation stays beside its source label',
          );
          assert.ok(sourceLabel.transform[4] < explanation.transform[4]);
          assert.equal(sourceLabel.transform[5], explanation.transform[5]);
          assert.notEqual(
            sourceLabel.fontName,
            explanation.fontName,
            'Only the source label is bold',
          );
        }
        originalBody.push(
          ...text
            .filter((item) => item.transform[5] > 60 && item.transform[5] < 720)
            .map((item) => item.str),
        );
      }
    }
    assert.equal(
      contentsLinks,
      bundle.items.length,
      'Every shiur has a clickable contents entry',
    );
    assert.ok(hasSourceLink, 'Original source hyperlink survives');
    assert.ok(hasHebrewLabel, 'Original Hebrew text survives');
    const body = originalBody.join(' ').replace(/\s+/gu, ' ');
    let previous = -1;
    for (const paragraph of paragraphs) {
      const position = body.indexOf(paragraph);
      assert.ok(
        position > previous,
        `Original paragraph survives in order: ${paragraph}`,
      );
      previous = position;
    }
    assert.equal(
      body.split(firstTitle).length - 1,
      1,
      'Matching note title appears once in the chapter opening',
    );
    for (let i = 1; i < bundle.items.length; i++) {
      assert.ok(
        body.includes(`Original note ${i + 1}`),
        'A distinct note heading is retained',
      );
      assert.ok(body.includes(`Unique explanation ${i + 1} is preserved.`));
    }
  } finally {
    await loading.destroy();
  }
});
