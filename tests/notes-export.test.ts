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
import { createNotesPdf } from '../lib/notes-pdf';
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

void test('PDF uses US Letter pages and keeps bold Hebrew source labels before explanations', async () => {
  // Pre-register local copies so the real browser exporter also runs in Node.
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
      ],
    });
  }
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
