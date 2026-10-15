import {
  Document,
  Page,
  Text,
  View,
  Link,
  Font,
  pdf,
  type DocumentProps,
} from '@react-pdf/renderer';
import type { ReactElement } from 'react';
import { notesBlocks } from './notes-document';

let registered = false;
function registerFonts() {
  if (registered) return;
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

async function render(document: ReactElement<DocumentProps>) {
  registerFonts();
  return pdf(document)
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

const pageStyle = {
  padding: 48,
  fontFamily: ['NotesLatin', 'Notes'],
  fontSize: 11,
  lineHeight: 1.5,
  color: '#222222',
};

function NotesBody({ markdown }: { markdown: string }) {
  return notesBlocks(markdown).map((block, index) => (
    <Text
      key={index}
      minPresenceAhead={block.heading ? 30 : 0}
      style={{
        fontSize: block.heading ? Math.max(12, 22 - block.heading * 2) : 11,
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
          fontStyle: run.italic ? ('italic' as const) : ('normal' as const),
        };
        return run.url ? (
          <Link key={i} src={run.url} style={{ ...style, color: '#235c57' }}>
            {run.text}
          </Link>
        ) : (
          <Text key={i} style={style}>
            {run.text}
          </Text>
        );
      })}
    </Text>
  ));
}

export async function createNotesPdf(markdown: string): Promise<Blob> {
  return render(
    <Document title="Notes" author="YUTorah">
      <Page size="LETTER" style={pageStyle}>
        <NotesBody markdown={markdown} />
      </Page>
    </Document>,
  );
}

export type NotesBundleDocument = {
  title: string;
  subtitle: string;
  items: {
    id: number;
    title: string;
    teacher: string;
    date: string;
    markdown: string;
  }[];
};

const dateLabel = (value: string) =>
  value
    ? new Date(value).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : '';

export async function createNotesBundlePdf({
  title,
  subtitle,
  items,
}: NotesBundleDocument): Promise<Blob> {
  const muted = { color: '#6b6b6b' };
  return render(
    <Document title={title} author="YUTorah">
      <Page size="LETTER" style={pageStyle}>
        <Text style={{ fontSize: 11, ...muted, marginBottom: 10 }}>
          YUTorah shiur notes
        </Text>
        <Text
          style={{
            fontSize: 26,
            fontWeight: 700,
            lineHeight: 1.25,
            marginBottom: 8,
          }}
        >
          {title}
        </Text>
        <Text style={{ fontSize: 12, ...muted, marginBottom: 28 }}>
          {subtitle}
        </Text>
        <Text style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
          Contents
        </Text>
        {items.map((item, index) => (
          <Link
            key={item.id}
            src={'#shiur-' + item.id}
            style={{ color: '#222222', textDecoration: 'none' }}
          >
            <Text style={{ fontSize: 10.5, marginBottom: 5 }}>
              {index + 1}. {item.title}
              <Text style={muted}>
                {'  '}
                {[item.teacher, dateLabel(item.date)]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </Text>
          </Link>
        ))}
      </Page>
      {items.map((item) => (
        <Page key={item.id} size="LETTER" style={pageStyle}>
          <View id={'shiur-' + item.id} style={{ marginBottom: 18 }}>
            <Text style={{ fontSize: 10, ...muted, marginBottom: 4 }}>
              {[item.teacher, dateLabel(item.date)].filter(Boolean).join(' · ')}
            </Text>
            <Text style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.35 }}>
              {item.title}
            </Text>
          </View>
          <NotesBody markdown={item.markdown} />
        </Page>
      ))}
    </Document>,
  );
}
