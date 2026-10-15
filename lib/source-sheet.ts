import type { TranscriptSource } from './sources';
import type { SourceText } from './sefaria';
import { timeLabel } from './library';
export type SheetLanguage = 'both' | 'he' | 'en';
export function sourceEditions(
  text: SourceText | undefined,
  language: SheetLanguage = 'he',
) {
  return (text?.editions || []).filter((e) => {
    const english = /^(en|eng|english)$/i.test(e.language);
    return language === 'both' || (language === 'en' ? english : !english);
  });
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const time = (ms: number) => timeLabel(ms / 1000);

/** One escaped, standalone document is used for download and browser print/PDF. */
export type SourceSheetOptions = {
  shiurId: number;
  title: string;
  teacher: string;
  origin: string;
  sources: TranscriptSource[];
  texts: Record<string, SourceText>;
  limited: boolean;
  language?: SheetLanguage;
  extent?: 'excerpt' | 'full';
  includeLinks?: boolean;
  introduction?: string;
  comments?: Record<string, string>;
  incomplete?: boolean;
};
export function sourceProvenance(source: TranscriptSource) {
  const origins = new Set(
    source.occurrences.map((o) => o.origin || 'transcript'),
  );
  return [
    origins.has('transcript') ? 'Transcript' : '',
    origins.has('notes') ? 'Published notes' : '',
    origins.has('manual') ? 'Added by you' : '',
  ]
    .filter(Boolean)
    .join(' / ');
}
const publicLink = (url: string) => (/^https?:\/\//iu.test(url) ? url : '');
export function renderSourceSheet(options: SourceSheetOptions) {
  const { sources, texts } = options;
  const shiurUrl = new URL(`/?shiur=${options.shiurId}`, options.origin).href;
  const link = (url: string, label: string) =>
    options.includeLinks !== false && publicLink(url)
      ? `<a href="${escape(url)}">${escape(label)}</a>`
      : escape(label);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(options.title)} — Source sheet</title><style>
    @page{size:auto;margin:18mm}*{box-sizing:border-box}body{font:16px/1.75 Georgia,serif;color:#0b0b0c;background:#fff;max-width:850px;margin:36px auto;padding:0 24px}header{border-bottom:1px solid #dcdce0;padding-bottom:22px}h1{font-size:30px;line-height:1.25;margin:8px 0}h2{font-size:21px;margin:0}.eyebrow,.meta,.attribution{font:12px/1.6 Arial,sans-serif;color:#6b6b74}article{padding:24px 0;border-bottom:1px solid #e9e9ed;break-inside:avoid}a{color:inherit;text-underline-offset:3px;overflow-wrap:anywhere}blockquote{border-left:2px solid #dcdce0;margin:10px 0;padding-left:14px;font-size:14px}.source-text{white-space:pre-wrap;margin:14px 0}.source-text[dir=rtl]{font-size:21px;line-height:1.95}.attribution{margin:6px 0}footer{margin-top:24px} @media print{body{margin:0;max-width:none;padding:0}a{text-decoration:none;color:inherit}header{break-after:avoid}}
    </style></head><body><header><div class="eyebrow">YUTorah Study · Source sheet</div><h1 dir="auto">${escape(options.title)}</h1><p dir="auto">${escape(options.teacher)}</p><p class="meta">${sources.length} selected source${sources.length === 1 ? '' : 's'} · <a href="${escape(shiurUrl)}">Open shiur</a></p><p class="meta">References checked against Sefaria. Sources from published notes and manual additions are labeled. Recording times mark segment starts.${options.incomplete ? ' This is a partial sheet; source checking is still in progress.' : ''}${options.limited ? ' Processing limits were reached; this sheet may omit sources.' : ''}</p>${options.introduction ? `<p class="source-text" dir="auto">${escape(options.introduction)}</p>` : ''}</header>
    ${sources
      .map((source, i) => {
        const data = texts[source.ref];
        const heading =
          options.language === 'en' ? source.ref : source.heRef || source.ref;
        return `<article><div class="eyebrow">${i + 1} · ${escape(data?.categories.join(' / ') || source.category)}</div><h2 dir="auto">${link(source.url, heading)}</h2>${options.language === 'both' ? `<div>${escape(source.ref)}</div>` : ''}<p class="meta">${escape(sourceProvenance(source))}</p>${
          source.occurrences.some((o) => !o.origin || o.origin === 'transcript')
            ? `<p class="meta">Mentioned at ${Array.from(
                new Set(
                  source.occurrences
                    .filter((o) => !o.origin || o.origin === 'transcript')
                    .map((o) => o.startMs),
                ),
              )
                .map(
                  (ms) =>
                    `<a href="${escape(shiurUrl + '&t=' + Math.floor(ms / 1000))}">${time(ms)}</a>`,
                )
                .join(', ')}</p>`
            : ''
        }${options.comments?.[source.ref] ? `<p class="source-text" dir="auto">${escape(options.comments[source.ref])}</p>` : ''}
      ${
        sourceEditions(data, options.language).length
          ? sourceEditions(data, options.language)
              .map(
                (edition) =>
                  `<div class="source-text" dir="${edition.direction}">${edition.text.map(escape).join('\n\n')}</div>${edition.truncated ? `<p class="meta">${options.extent === 'full' ? 'Long text shortened for this sheet' : 'Excerpt'}; the complete cited text is available on Sefaria.</p>` : ''}<p class="attribution">${escape(edition.title)} · ${escape(edition.language)} · ${escape(edition.license)}${edition.versionSource ? ` · ${link(edition.versionSource, 'Edition source')}` : ''} · ${link(source.url, 'Sefaria')}</p>`,
              )
              .join('')
          : '<p class="meta">Text in the selected language is unavailable. This sheet contains the reference only.</p>'
      }${options.includeLinks !== false ? `<p class="meta">${link(source.url, source.url)}</p>` : ''}</article>`;
      })
      .join('')}
    <footer class="meta">Source text and metadata supplied by Sefaria. Each edition retains its attribution and license. Automatic source identification can miss references. Review this sheet against the shiur.</footer></body></html>`;
}

const markdownText = (text: string) =>
  text.replace(/([\\`*_{}[\]<>#!|])/g, '\\$1');
/** PDF and Word use the same selected sources, languages, comments, and attribution as HTML. */
export function sourceSheetMarkdown(options: SourceSheetOptions) {
  const link = (url: string, text: string) =>
    options.includeLinks !== false && publicLink(url)
      ? `[${markdownText(text)}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})`
      : markdownText(text);
  return [
    `# ${markdownText(options.title)}`,
    markdownText(options.teacher),
    `${options.sources.length} selected sources. References checked against Sefaria.`,
    options.incomplete
      ? 'Partial sheet: source checking is still in progress.'
      : '',
    options.limited
      ? 'Processing limits were reached; some sources may be missing.'
      : '',
    markdownText(options.introduction || ''),
    ...options.sources.flatMap((source, index) => {
      const data = options.texts[source.ref];
      const times = [
        ...new Set(
          source.occurrences
            .filter((o) => !o.origin || o.origin === 'transcript')
            .map((o) => time(o.startMs)),
        ),
      ];
      return [
        `## ${index + 1}. ${link(source.url, options.language === 'en' ? source.ref : source.heRef || source.ref)}`,
        options.language === 'both' ? markdownText(source.ref) : '',
        sourceProvenance(source) +
          (times.length ? `, mentioned at ${times.join(', ')}` : ''),
        markdownText(options.comments?.[source.ref] || ''),
        ...sourceEditions(data, options.language).flatMap((edition) => [
          ...edition.text.map(markdownText),
          edition.truncated
            ? 'Excerpt; the complete cited text is available on Sefaria.'
            : '',
          `${markdownText(edition.title)} · ${markdownText(edition.language)} · ${markdownText(edition.license)} · ${link(source.url, 'Sefaria')}${edition.versionSource ? ` · ${link(edition.versionSource, 'Edition source')}` : ''}`,
        ]),
        !sourceEditions(data, options.language).length
          ? 'Text in the selected language is unavailable. Reference only.'
          : '',
      ];
    }),
    'Source text and metadata supplied by Sefaria. Review automatic references against the recording.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
