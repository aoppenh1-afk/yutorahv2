import {
  Document,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  Packer,
  HeadingLevel,
  AlignmentType,
} from 'docx';
import { notesBlocks } from './notes-document';

export async function createNotesDocx(markdown: string): Promise<Blob> {
  const headings = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];
  const children = notesBlocks(markdown).map((block) => {
    const runs = block.runs.flatMap((run) =>
      run.text.split('\n').map((text, index) => {
        const child = new TextRun({
          text,
          bold: run.bold,
          italics: run.italic,
          rightToLeft: false,
          ...(index ? { break: 1 } : {}),
          ...(run.code ? { font: 'Courier New' } : {}),
        });
        return run.url
          ? new ExternalHyperlink({ link: run.url, children: [child] })
          : child;
      }),
    );
    return new Paragraph({
      children: [
        ...(block.prefix
          ? [new TextRun({ text: block.prefix, rightToLeft: false })]
          : []),
        ...runs,
      ],
      heading: block.heading ? headings[block.heading - 1] : undefined,
      // Keep the viewer's LTR outline. The shared directional marks separate
      // source labels from explanations while retaining Hebrew phrase order.
      bidirectional: false,
      alignment: AlignmentType.LEFT,
      indent: { left: (block.indent ?? 0) * 360 },
      spacing: { after: 160, line: 300 },
      keepNext: Boolean(block.heading),
    });
  });
  return Packer.toBlob(
    new Document({
      title: 'Notes',
      creator: 'YUTorah',
      styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
      sections: [{ children }],
    }),
  );
}
