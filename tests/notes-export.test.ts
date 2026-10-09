import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createNotesDocx } from '../lib/notes-docx';
import { notesBlocks, notesDirection } from '../lib/notes-document';

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
  assert.equal(notesDirection('123 תורה and learning'), 'rtl');
  assert.equal(notesDirection('English with תורה'), 'ltr');
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
  assert.match(xml, /<w:bidi\/>/);
  // DOCX stores physical right alignment as left when w:bidi is enabled.
  assert.match(xml, /<w:bidi\/>.*?<w:jc w:val="left"\/>/);
  assert.match(xml, /3\. /);
  assert.match(xml, /Nested point/);
  assert.match(relationships, /https:\/\/www.sefaria.org\/Genesis.1.1/);
  assert.match(relationships, /https:\/\/www.sefaria.org\/Exodus.1.1/);
  assert.doesNotMatch(relationships, /javascript:/);
});
