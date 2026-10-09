import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Font } from '@react-pdf/renderer';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';
import { createNotesDocx } from '../lib/notes-docx';
import { createNotesPdf } from '../lib/notes-pdf';
import { notesBlocks } from '../lib/notes-document';

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
`;

void test('Word paragraphs keep the preview’s left-to-right layout when an English explanation starts in Hebrew', async () => {
  const blob = await createNotesDocx(mixedNotes);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('word/document.xml')!.async('string');
  const paragraphs = xml.match(/<w:p>.*?<\/w:p>/g)!;
  assert.equal(paragraphs.length, 4);
  for (const paragraph of paragraphs) {
    assert.match(paragraph, /<w:bidi w:val="false"\/>/);
    assert.match(paragraph, /<w:jc w:val="left"\/>/);
    assert.doesNotMatch(paragraph, /<w:rtl\/>/);
  }
});

void test('PDF keeps Hebrew-led English explanations on the left with Hebrew before the explanation', async () => {
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
  } finally {
    await loading.destroy();
  }
});
