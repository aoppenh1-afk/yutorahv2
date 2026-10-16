import type { TranscriptSource } from './sources';
import type { SourceEdition, SourceText } from './sefaria';

export type SheetLanguage = 'both' | 'he' | 'en';
export function sourceEditions(
  text: SourceText | undefined,
  language: SheetLanguage = 'he',
) {
  return (text?.editions || [])
    .filter((e) => {
      const english = /^(en|eng|english)$/i.test(e.language);
      return language === 'both' || (language === 'en' ? english : !english);
    })
    .sort(
      (a, b) => Number(a.direction === 'rtl') - Number(b.direction === 'rtl'),
    );
}

/** Keep corresponding passages together, including editions with fewer paragraphs. */
export function sourceTextRows(editions: SourceEdition[]) {
  return Array.from(
    { length: Math.max(0, ...editions.map((edition) => edition.text.length)) },
    (_, index) => editions.map((edition) => edition.text[index] ?? ''),
  );
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

/** One escaped, standalone document is used for download and browser print/PDF. */
export type SourceSheetOptions = {
  shiurId: number;
  title: string;
  teacher: string;
  origin: string;
  sources: TranscriptSource[];
  texts: Record<string, SourceText>;
  limited?: boolean;
  language?: SheetLanguage;
  extent?: 'excerpt' | 'full';
  includeLinks?: boolean;
  introduction?: string;
  comments?: Record<string, string>;
  incomplete?: boolean;
};
const publicLink = (url: string) => (/^https?:\/\//iu.test(url) ? url : '');
export function renderSourceSheet(options: SourceSheetOptions) {
  const { sources, texts } = options;
  const shiurUrl = new URL(`/?shiur=${options.shiurId}`, options.origin).href;
  const language = options.language ?? 'he';
  const link = (url: string, label: string) =>
    options.includeLinks !== false && publicLink(url)
      ? `<a href="${escape(url)}">${escape(label)}</a>`
      : escape(label);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(options.title)} — Source sheet</title><style>
    @page { size: auto; margin: 18mm; }
    * { box-sizing: border-box; }
    body { font: 11.5pt/1.6 Georgia, "Times New Roman", serif; color: #222; background: #fff; max-width: 760px; margin: 36px auto; padding: 0 24px; }
    a { color: inherit; text-decoration: none; }
    .sheet-header { text-align: center; padding-bottom: 20px; border-bottom: 1px solid #333; margin-bottom: 24px; }
    .brand, .teacher, .meta { font-family: Arial, sans-serif; }
    .brand { font-size: 8pt; letter-spacing: .14em; text-transform: uppercase; color: #666; }
    h1 { font-size: 24pt; font-weight: normal; line-height: 1.2; margin: 10px 0; overflow-wrap: anywhere; }
    .sheet-introduction, .source-comment { white-space: pre-wrap; text-align: start; }
    .teacher { font-size: 10pt; margin: 0; }
    article { margin: 0 0 24px; }
    .source-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; margin: 0 0 12px; font-size: 12pt; line-height: 1.4; break-after: avoid; }
    .source-heading a { overflow-wrap: anywhere; }
    .source-number { font: 9pt Arial, sans-serif; color: #777; margin-right: 8px; }
    .he-ref { font-family: "Times New Roman", serif; font-size: 13pt; font-weight: normal; text-align: right; }
    .source-passages { width: 100%; table-layout: fixed; border-collapse: collapse; }
    .source-passages tr { break-inside: avoid; }
    .source-text { vertical-align: top; padding: 0; overflow-wrap: anywhere; white-space: pre-wrap; orphans: 3; widows: 3; }
    .source-text + .source-text { padding-left: 22px; }
    .source-text[dir=rtl] { font-family: "Times New Roman", serif; font-size: 14pt; line-height: 1.7; text-align: right; }
    .source-text p { margin: 0 0 10px; }
    .meta { color: #666; font-size: 8pt; margin: 4px 0 0; }
    @media screen and (max-width: 540px) { body { padding: 0 16px; margin: 24px auto; } h1 { font-size: 20pt; } .source-passages, .source-passages tbody, .source-passages tr, .source-passages td { display: block; } .source-text + .source-text { padding-left: 0; } }
    @media print { body { margin: 0; max-width: none; padding: 0; } .sheet-header { break-inside: avoid; break-after: avoid; } a { text-decoration: none; } }
    </style></head><body><header class="sheet-header"><div class="brand">${link(shiurUrl, 'YUTorah · Source sheet')}</div><h1 dir="auto">${escape(options.title)}</h1>${options.teacher ? `<p class="teacher" dir="auto">${escape(options.teacher)}</p>` : ''}${options.introduction ? `<p class="sheet-introduction" dir="auto">${escape(options.introduction)}</p>` : ''}</header>
    ${sources
      .map((source, i) => {
        const editions = sourceEditions(texts[source.ref], language);
        const shortened = editions.some((edition) => edition.truncated);
        return `<article><h2 class="source-heading"><span><span class="source-number">${i + 1}.</span>${link(source.url, source.ref)}</span>${language !== 'en' && source.heRef ? `<span class="he-ref" dir="rtl">${link(source.url, source.heRef)}</span>` : ''}</h2>${options.comments?.[source.ref] ? `<p class="source-comment" dir="auto">${escape(options.comments[source.ref])}</p>` : ''}
      ${
        editions.length
          ? `<table class="source-passages" role="presentation"><tbody>${sourceTextRows(
              editions,
            )
              .map(
                (row) =>
                  `<tr>${row.map((text, index) => `<td class="source-text" dir="${editions[index].direction}" lang="${escape(editions[index].language)}">${text ? `<p>${escape(text)}</p>` : ''}</td>`).join('')}</tr>`,
              )
              .join(
                '',
              )}</tbody></table>${shortened ? `<p class="meta">${options.extent === 'full' ? 'Text shortened' : 'Excerpt'} · ${link(source.url, 'Full text on Sefaria')}</p>` : ''}`
          : `<p class="meta">Text unavailable in this language. ${link(source.url, 'Read on Sefaria.')}</p>`
      }</article>`;
      })
      .join('')}
    </body></html>`;
}

const markdownText = (text: string) =>
  text.replace(/([\\`*_{}[\]<>#!|])/g, '\\$1');
/** Word and PDF retain the selected passages and personal notes without edition footnotes. */
export function sourceSheetMarkdown(options: SourceSheetOptions) {
  const language = options.language ?? 'he';
  const link = (url: string, text: string) =>
    options.includeLinks !== false && publicLink(url)
      ? `[${markdownText(text)}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})`
      : markdownText(text);
  return [
    `# ${markdownText(options.title)}`,
    markdownText(options.teacher),
    markdownText(options.introduction || ''),
    ...options.sources.flatMap((source, index) => {
      const editions = sourceEditions(options.texts[source.ref], language);
      return [
        `## ${index + 1}. ${link(source.url, language === 'en' ? source.ref : source.heRef || source.ref)}`,
        language === 'both' ? markdownText(source.ref) : '',
        markdownText(options.comments?.[source.ref] || ''),
        ...editions.flatMap((edition) => edition.text.map(markdownText)),
        !editions.length
          ? 'Text in the selected language is unavailable. Reference only.'
          : '',
      ];
    }),
  ]
    .filter(Boolean)
    .join('\n\n');
}
