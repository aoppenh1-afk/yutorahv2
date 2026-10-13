import type { Shiur } from './yutorah';
export type FeedbackKind =
  | 'comment'
  | 'suggestion'
  | 'question'
  | 'interface'
  | 'content';
export function feedbackLink(
  kind: FeedbackKind,
  message: string,
  page: string,
  shiur?: Pick<Shiur, 'id' | 'title' | 'url'>,
) {
  const to = kind === 'content' ? 'errors@yutorah.org' : 'yutorahv2@gmail.com';
  const subject =
    kind === 'content'
      ? `YUTorah content error${shiur ? ' — shiur ' + shiur.id : ''}`
      : `YUTorah Library — ${kind}`;
  const body = [
    message.trim(),
    '',
    'Page: ' + page,
    ...(shiur
      ? [
          'Shiur ID: ' + shiur.id,
          'Title: ' + shiur.title,
          'Original: ' + shiur.url,
        ]
      : []),
  ].join('\n');
  return (
    'mailto:' +
    to +
    '?' +
    new URLSearchParams({ subject, body }).toString().replace(/\+/g, '%20')
  );
}
