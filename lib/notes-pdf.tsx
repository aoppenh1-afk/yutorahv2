import { Document, Page, Text, Link, Font, pdf } from '@react-pdf/renderer';
import { notesBlocks } from './notes-document';

let registered = false;
export async function createNotesPdf(markdown: string): Promise<Blob> {
  if (!registered) {
    Font.register({
      family: 'Notes',
      fonts: [
        { src: '/fonts/notes/NotoSansHebrew-Regular.ttf', fontWeight: 400 },
        { src: '/fonts/notes/NotoSansHebrew-Bold.ttf', fontWeight: 700 },
        {
          src: '/fonts/notes/NotoSansHebrew-Regular.ttf',
          fontWeight: 400,
          fontStyle: 'italic',
        },
        {
          src: '/fonts/notes/NotoSansHebrew-Bold.ttf',
          fontWeight: 700,
          fontStyle: 'italic',
        },
      ],
    });
    Font.register({
      family: 'NotesLatin',
      fonts: [
        { src: '/fonts/notes/NotoSans-Regular.ttf', fontWeight: 400 },
        { src: '/fonts/notes/NotoSans-Bold.ttf', fontWeight: 700 },
        {
          src: '/fonts/notes/NotoSans-Italic.ttf',
          fontWeight: 400,
          fontStyle: 'italic',
        },
        {
          src: '/fonts/notes/NotoSans-BoldItalic.ttf',
          fontWeight: 700,
          fontStyle: 'italic',
        },
      ],
    });
    Font.registerHyphenationCallback((word) => [word]);
    registered = true;
  }
  return pdf(
    <Document title="Notes" author="YUTorah">
      <Page
        size="A4"
        style={{
          padding: 48,
          fontFamily: ['NotesLatin', 'Notes'],
          fontSize: 11,
          lineHeight: 1.5,
          color: '#222222',
        }}
      >
        {notesBlocks(markdown).map((block, index) => {
          return (
            <Text
              key={index}
              minPresenceAhead={block.heading ? 30 : 0}
              style={{
                fontSize: block.heading
                  ? Math.max(12, 22 - block.heading * 2)
                  : 11,
                fontWeight: block.heading ? 700 : 400,
                marginTop: block.heading ? 12 : 0,
                marginBottom: 8,
                // Shared directional marks keep source labels and Hebrew
                // explanations in the same LTR outline as the viewer.
                textAlign: 'left',
                direction: 'ltr',
                marginLeft: (block.indent ?? 0) * 14,
              }}
            >
              {block.prefix}
              {block.runs.map((run, i) => {
                const style = {
                  fontWeight: run.bold || block.heading ? 700 : 400,
                  fontStyle: run.italic
                    ? ('italic' as const)
                    : ('normal' as const),
                };
                return run.url ? (
                  <Link
                    key={i}
                    src={run.url}
                    style={{ ...style, color: '#235c57' }}
                  >
                    {run.text}
                  </Link>
                ) : (
                  <Text key={i} style={style}>
                    {run.text}
                  </Text>
                );
              })}
            </Text>
          );
        })}
      </Page>
    </Document>,
  )
    .toBlob()
    .catch((error: unknown) => {
      // Font loading caches rejected promises. Re-register on the next attempt
      // so a temporary network failure can recover without a page reload.
      const fonts = Font.getRegisteredFonts();
      delete fonts.Notes;
      delete fonts.NotesLatin;
      registered = false;
      throw error;
    });
}
