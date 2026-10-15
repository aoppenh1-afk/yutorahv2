import {
  Document,
  Page,
  Text,
  View,
  Link,
  Font,
  StyleSheet,
  pdf,
  type DocumentProps,
} from '@react-pdf/renderer';
import type { ReactElement } from 'react';
import { notesBlocks, type NotesBlock } from './notes-document';
import { stripNotesDirectionControls } from './notes-direction';

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
  Font.register({
    family: 'NotesDisplay',
    fonts: [
      { src: '/fonts/notes/SourceSerif4-Regular.ttf', fontWeight: 400 },
      { src: '/fonts/notes/SourceSerif4-Semibold.ttf', fontWeight: 700 },
      {
        src: '/fonts/notes/SourceSerif4-It.ttf',
        fontWeight: 400,
        fontStyle: 'italic',
      },
      {
        src: '/fonts/notes/SourceSerif4-SemiboldIt.ttf',
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
      delete fonts.NotesDisplay;
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

function NotesBody({
  blocks,
  bundle = false,
  chapterTitle = false,
}: {
  blocks: NotesBlock[];
  bundle?: boolean;
  chapterTitle?: boolean;
}) {
  return blocks.map((block, index) => (
    <Text
      key={index}
      minPresenceAhead={block.heading ? (bundle ? 44 : 30) : 0}
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
        ...(bundle
          ? {
              fontSize: block.heading
                ? [21, 16, 12, 11, 10.5, 10.5][block.heading - 1]
                : 10.5,
              fontFamily:
                block.heading && block.heading <= 2
                  ? ['NotesDisplay', 'Notes']
                  : ['NotesLatin', 'Notes'],
              lineHeight: block.heading ? 1.3 : 1.6,
              color: block.heading ? bundleColors.ink : bundleColors.body,
              marginTop: block.heading ? 19 : 0,
              marginBottom: block.heading ? 10 : 8,
              marginLeft: (block.indent ?? 0) * 12,
            }
          : {}),
        ...(chapterTitle ? { ...bundleStyles.chapterTitle, marginTop: 0 } : {}),
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
        <NotesBody blocks={notesBlocks(markdown)} />
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

const bundleColors = {
  ink: '#162e40',
  body: '#30373c',
  muted: '#6a747b',
  rule: '#dce0e2',
  accent: '#a1814f',
  paper: '#faf8f3',
};

const bundleStyles = StyleSheet.create({
  page: {
    ...pageStyle,
    paddingTop: 84,
    paddingBottom: 70,
    paddingHorizontal: 54,
    fontSize: 10.5,
    // Keep leading on the text blocks. Inherited lineHeight is multiplied
    // again when the renderer lays out dynamic page numbers.
    lineHeight: undefined,
    color: bundleColors.body,
  },
  cover: {
    paddingTop: 62,
    paddingBottom: 62,
    paddingHorizontal: 64,
    backgroundColor: bundleColors.paper,
  },
  coverSpine: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 12,
    backgroundColor: bundleColors.ink,
  },
  coverFrame: {
    position: 'absolute',
    left: 30,
    right: 30,
    top: 30,
    bottom: 30,
    borderWidth: 0.75,
    borderColor: '#d4c8b4',
  },
  wordmark: {
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: -0.7,
    color: bundleColors.ink,
  },
  coverMasthead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 22,
    borderBottomWidth: 0.75,
    borderBottomColor: '#d4c8b4',
  },
  coverTitleBlock: { marginTop: 98 },
  accent: {
    width: 30,
    height: 2,
    backgroundColor: bundleColors.accent,
    marginBottom: 20,
  },
  eyebrow: {
    fontSize: 7.5,
    fontWeight: 700,
    letterSpacing: 1.4,
    color: bundleColors.muted,
  },
  coverTitle: {
    fontFamily: ['NotesDisplay', 'Notes'],
    fontWeight: 400,
    fontSize: 44,
    lineHeight: 1.13,
    letterSpacing: -0.7,
    color: bundleColors.ink,
    marginTop: 18,
    marginBottom: 24,
  },
  coverSubtitle: {
    fontSize: 10.5,
    lineHeight: 1.7,
    color: bundleColors.muted,
    maxWidth: 440,
  },
  coverDetails: {
    position: 'absolute',
    left: 64,
    right: 64,
    bottom: 122,
    borderTopWidth: 0.75,
    borderTopColor: '#d4c8b4',
    paddingTop: 18,
    flexDirection: 'row',
  },
  coverDetailColumn: { flex: 1 },
  coverDetailValue: {
    fontSize: 10,
    lineHeight: 1.5,
    marginTop: 8,
    color: bundleColors.ink,
  },
  coverFooter: {
    position: 'absolute',
    bottom: 62,
    left: 64,
    right: 64,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  coverFooterLink: {
    fontSize: 8,
    color: bundleColors.muted,
    textDecoration: 'none',
  },
  header: {
    position: 'absolute',
    top: 30,
    left: 54,
    right: 54,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 0.5,
    borderBottomColor: bundleColors.rule,
    paddingBottom: 11,
  },
  headerBrand: {
    width: 72,
    fontSize: 8,
    fontWeight: 700,
    color: bundleColors.ink,
  },
  headerTitle: {
    flex: 1,
    fontSize: 7.5,
    color: bundleColors.muted,
    textAlign: 'right',
    maxLines: 1,
    textOverflow: 'ellipsis',
  },
  footer: {
    position: 'absolute',
    bottom: 30,
    left: 54,
    right: 54,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 0.5,
    borderTopColor: bundleColors.rule,
    paddingTop: 10,
    fontSize: 7.5,
    color: bundleColors.muted,
  },
  footerLink: { color: bundleColors.muted, textDecoration: 'none' },
  pageNumber: { width: 90, textAlign: 'right', height: 12 },
  contentsHeading: {
    position: 'absolute',
    top: 86,
    left: 54,
    right: 54,
  },
  contentsHeadingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  contentsTitle: {
    fontFamily: ['NotesDisplay', 'Notes'],
    fontSize: 34,
    lineHeight: 1.2,
    color: bundleColors.ink,
    letterSpacing: -0.5,
  },
  contentsCount: { fontSize: 8.5, color: bundleColors.muted },
  contentsColumns: {
    position: 'absolute',
    top: 178,
    left: 54,
    right: 54,
    flexDirection: 'row',
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: bundleColors.ink,
  },
  contentsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: bundleColors.rule,
    textDecoration: 'none',
    color: bundleColors.body,
  },
  contentsIndex: {
    width: 42,
    fontFamily: 'NotesDisplay',
    fontSize: 17,
    lineHeight: 1.3,
    color: bundleColors.accent,
  },
  contentsEntry: { flex: 1 },
  contentsEntryTitle: {
    fontFamily: ['NotesDisplay', 'Notes'],
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1.45,
    color: bundleColors.ink,
  },
  contentsMeta: {
    fontSize: 8,
    color: bundleColors.muted,
    lineHeight: 1.5,
    marginTop: 5,
  },
  contentsPage: {
    width: 40,
    height: 19,
    marginLeft: 14,
    fontFamily: 'NotesDisplay',
    fontSize: 13,
    textAlign: 'right',
    color: bundleColors.ink,
  },
  chapter: {
    borderBottomWidth: 0.75,
    borderBottomColor: bundleColors.rule,
    paddingBottom: 22,
    marginBottom: 4,
  },
  chapterLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
  },
  chapterLabel: { height: 14, color: bundleColors.accent },
  chapterRule: {
    width: 32,
    height: 1,
    backgroundColor: bundleColors.accent,
    marginLeft: 12,
  },
  chapterTitle: {
    fontFamily: ['NotesDisplay', 'Notes'],
    fontWeight: 700,
    fontSize: 28,
    lineHeight: 1.25,
    color: bundleColors.ink,
    marginBottom: 14,
  },
  chapterMeta: { fontSize: 9, color: bundleColors.muted, lineHeight: 1.5 },
});

function BundlePageChrome({
  title,
  contents = false,
}: {
  title: string;
  contents?: boolean;
}) {
  return (
    <>
      <View fixed style={bundleStyles.header}>
        <Text style={bundleStyles.headerBrand}>YUTorah</Text>
        <Text style={bundleStyles.headerTitle}>{title}</Text>
      </View>
      <View fixed style={bundleStyles.footer}>
        {contents ? (
          <Text>Shiur notes</Text>
        ) : (
          <Link src="#contents" style={bundleStyles.footerLink}>
            Back to contents
          </Link>
        )}
        <Text
          style={bundleStyles.pageNumber}
          render={({ pageNumber, totalPages }) =>
            `${pageNumber} / ${totalPages}`
          }
        />
      </View>
    </>
  );
}

export async function createNotesBundlePdf({
  title,
  subtitle,
  items,
}: NotesBundleDocument): Promise<Blob> {
  // The renderer resolves dynamic text during pagination, then again after
  // every page is known. Chapter labels record their first-pass page; contents
  // numbers read it in the final pass. Fixed-size boxes keep pagination stable.
  const chapterPages = new Map<number, number>();
  const dates = items
    .map((item) => Date.parse(item.date))
    .filter(Number.isFinite);
  const firstDate = dates.length
    ? dateLabel(new Date(Math.min(...dates)).toISOString())
    : '';
  const lastDate = dates.length
    ? dateLabel(new Date(Math.max(...dates)).toISOString())
    : '';
  const dateRange =
    firstDate === lastDate ? firstDate : `${firstDate} - ${lastDate}`;
  return render(
    <Document title={title} author="YUTorah">
      <Page
        size="LETTER"
        style={[bundleStyles.page, bundleStyles.cover]}
        bookmark="Cover"
      >
        <View style={bundleStyles.coverSpine} />
        <View style={bundleStyles.coverFrame} />
        <View style={bundleStyles.coverMasthead}>
          <Text style={bundleStyles.wordmark}>YUTorah</Text>
          <Text style={bundleStyles.eyebrow}>SHIUR NOTES</Text>
        </View>
        <View style={bundleStyles.coverTitleBlock}>
          <View style={bundleStyles.accent} />
          <Text style={bundleStyles.eyebrow}>COLLECTED SHIURIM</Text>
          <Text
            style={[
              bundleStyles.coverTitle,
              {
                fontSize:
                  title.length > 180
                    ? 26
                    : title.length > 100
                      ? 32
                      : title.length > 55
                        ? 38
                        : 44,
              },
            ]}
          >
            {title}
          </Text>
          <Text style={bundleStyles.coverSubtitle}>{subtitle}</Text>
        </View>
        <View style={bundleStyles.coverDetails}>
          <View style={bundleStyles.coverDetailColumn}>
            <Text style={bundleStyles.eyebrow}>IN THIS VOLUME</Text>
            <Text style={bundleStyles.coverDetailValue}>
              {items.length.toLocaleString()}{' '}
              {items.length === 1 ? 'shiur' : 'shiurim'}
            </Text>
          </View>
          {dateRange ? (
            <View style={bundleStyles.coverDetailColumn}>
              <Text style={bundleStyles.eyebrow}>LECTURE DATES</Text>
              <Text style={bundleStyles.coverDetailValue}>{dateRange}</Text>
            </View>
          ) : null}
        </View>
        <View style={bundleStyles.coverFooter}>
          <Link
            src="https://www.yutorah.org"
            style={bundleStyles.coverFooterLink}
          >
            yutorah.org
          </Link>
          <View style={[bundleStyles.accent, { marginBottom: 0 }]} />
        </View>
      </Page>
      <Page
        size="LETTER"
        style={[bundleStyles.page, { paddingTop: 201 }]}
        bookmark="Contents"
      >
        <BundlePageChrome title={title} contents />
        <View id="contents" />
        <View fixed style={bundleStyles.contentsHeading}>
          <Text style={bundleStyles.eyebrow}>IN THIS VOLUME</Text>
          <View style={bundleStyles.contentsHeadingRow}>
            <Text style={bundleStyles.contentsTitle}>Contents</Text>
            <Text style={bundleStyles.contentsCount}>
              {items.length.toLocaleString()}{' '}
              {items.length === 1 ? 'shiur' : 'shiurim'}
            </Text>
          </View>
        </View>
        <View fixed style={bundleStyles.contentsColumns}>
          <Text style={[bundleStyles.eyebrow, { width: 42 }]}>NO.</Text>
          <Text style={[bundleStyles.eyebrow, { flex: 1 }]}>SHIUR</Text>
          <Text
            style={[bundleStyles.eyebrow, { width: 40, textAlign: 'right' }]}
          >
            PAGE
          </Text>
        </View>
        {items.map((item, index) => (
          <Link
            key={item.id}
            src={'#shiur-' + item.id}
            wrap={false}
            style={bundleStyles.contentsRow}
          >
            <Text style={bundleStyles.contentsIndex}>
              {String(index + 1).padStart(2, '0')}
            </Text>
            <View style={bundleStyles.contentsEntry}>
              <Text style={bundleStyles.contentsEntryTitle}>{item.title}</Text>
              <Text style={bundleStyles.contentsMeta}>
                {[item.teacher, dateLabel(item.date)]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <Text
              style={bundleStyles.contentsPage}
              render={() => String(chapterPages.get(item.id) ?? '')}
            />
          </Link>
        ))}
      </Page>
      {items.map((item, index) => {
        const blocks = notesBlocks(item.markdown);
        // Use the note's own title in the chapter opening when it matches the
        // catalog title. Every original block is still rendered exactly once.
        const hasMatchingTitle =
          blocks[0]?.heading === 1 &&
          stripNotesDirectionControls(
            blocks[0].runs.map((run) => run.text).join(''),
          ).trim() === item.title.trim();
        return (
          <Page
            key={item.id}
            size="LETTER"
            style={bundleStyles.page}
            bookmark={`${index + 1}. ${item.title}`}
          >
            <BundlePageChrome title={item.title} />
            <View
              id={'shiur-' + item.id}
              style={bundleStyles.chapter}
              minPresenceAhead={72}
            >
              <View style={bundleStyles.chapterLabelRow}>
                <Text
                  style={[bundleStyles.eyebrow, bundleStyles.chapterLabel]}
                  render={({ pageNumber }) => {
                    chapterPages.set(item.id, pageNumber);
                    return `SHIUR ${String(index + 1).padStart(2, '0')}`;
                  }}
                />
                <View style={bundleStyles.chapterRule} />
              </View>
              {hasMatchingTitle ? (
                <NotesBody blocks={[blocks[0]]} bundle chapterTitle />
              ) : (
                <Text style={bundleStyles.chapterTitle}>{item.title}</Text>
              )}
              <Text style={bundleStyles.chapterMeta}>
                {[item.teacher, dateLabel(item.date)]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <NotesBody
              blocks={hasMatchingTitle ? blocks.slice(1) : blocks}
              bundle
            />
          </Page>
        );
      })}
    </Document>,
  );
}
