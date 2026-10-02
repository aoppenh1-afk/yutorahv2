import type { TranscriptSource } from './sources';
import type { SourceText } from './sefaria';
import { timeLabel } from './library';
export type SheetLanguage = 'both' | 'he' | 'en';
export function sourceEditions(
  text: SourceText | undefined,
  language: SheetLanguage = 'both',
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
export function renderSourceSheet(options: {
  shiurId: number;
  title: string;
  teacher: string;
  origin: string;
  sources: TranscriptSource[];
  texts: Record<string, SourceText>;
  limited: boolean;
  language?: SheetLanguage;
  extent?: 'excerpt' | 'full';
}) {
  const { sources, texts } = options;
  const shiurUrl = new URL(`/?shiur=${options.shiurId}`, options.origin).href;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(options.title)} — Source sheet</title><style>
    @page{size:auto;margin:18mm}*{box-sizing:border-box}body{font:16px/1.65 Georgia,serif;color:#182c3d;max-width:850px;margin:36px auto;padding:0 24px}header{border-bottom:3px solid #254f73;padding-bottom:22px}h1{font-size:30px;line-height:1.25;margin:8px 0}h2{font-size:21px;margin:0}.eyebrow,.meta,.attribution{font:12px/1.6 Arial,sans-serif;color:#526577}.eyebrow{letter-spacing:.14em;text-transform:uppercase}article{padding:24px 0;border-bottom:1px solid #d4dce3;break-inside:avoid}a{color:#164979;overflow-wrap:anywhere}blockquote{border-left:2px solid #d4dce3;margin:10px 0;padding-left:14px;font-size:14px}.source-text{white-space:pre-wrap;margin:14px 0}.source-text[dir=rtl]{font-size:20px}.attribution{margin:6px 0}footer{margin-top:24px} @media print{body{margin:0;max-width:none;padding:0}a{text-decoration:none;color:inherit}header{break-after:avoid}}
    </style></head><body><header><div class="eyebrow">YUTorah Study · Source sheet preview</div><h1>${escape(options.title)}</h1><p>${escape(options.teacher)}</p><p class="meta">${sources.length} cited source${sources.length === 1 ? '' : 's'} · <a href="${escape(shiurUrl)}">Open shiur</a></p><p class="meta">References identified automatically from explicit transcript citations. Timestamps mark the start of the transcript segment. Check against the recording.${options.limited ? ' Some sources or repeated timestamps were omitted because processing limits were reached.' : ''}</p></header>
    ${sources
      .map((source, i) => {
        const data = texts[source.ref];
        return `<article><div class="eyebrow">${i + 1} · ${escape(data?.categories.join(' / ') || source.category)}</div><h2><a href="${escape(source.url)}">${escape(source.ref)}</a></h2><div dir="rtl">${escape(source.heRef)}</div><p class="meta">Mentioned at ${Array.from(
          new Set(source.occurrences.map((o) => o.startMs)),
        )
          .map(
            (ms) =>
              `<a href="${escape(shiurUrl + '&t=' + Math.floor(ms / 1000))}">${time(ms)}</a>`,
          )
          .join(
            ', ',
          )}</p><blockquote dir="auto">${escape(source.occurrences[0].mention)}</blockquote>
      ${
        sourceEditions(data, options.language).length
          ? sourceEditions(data, options.language)
              .map(
                (edition) =>
                  `<div class="source-text" dir="${edition.direction}">${edition.text.map(escape).join('\n\n')}</div>${edition.truncated ? `<p class="meta">${options.extent === 'full' ? 'Long text shortened for this sheet' : 'Excerpt'}; open the Sefaria link for the complete cited text.</p>` : ''}<p class="attribution">${escape(edition.title)} · ${escape(edition.language)} · ${escape(edition.license)}${edition.versionSource ? ` · <a href="${escape(edition.versionSource)}">Edition source</a>` : ''} · <a href="${escape(source.url)}">Sefaria</a></p>`,
              )
              .join('')
          : '<p class="meta">Text in the selected language is unavailable. Use the citation link to read on Sefaria.</p>'
      }<p class="meta"><a href="${escape(source.url)}">${escape(source.url)}</a></p></article>`;
      })
      .join('')}
    <footer class="meta">Source text and metadata supplied by Sefaria. Each edition retains its attribution and license. This automatically assembled preview includes only accepted transcript citations; it is not an exhaustive bibliography.</footer></body></html>`;
}
