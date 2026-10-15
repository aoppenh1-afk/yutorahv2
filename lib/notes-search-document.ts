import type { Shiur } from './yutorah';
import { notesLimits, streamBytes } from './tidb-notes-store';

const encoding = 'gzip-base64-v1';

/** Store excerpts compactly; the separate normalized column remains searchable. */
export async function encodeSearchDocument(shiur: Shiur, text: string) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > notesLimits.raw)
    throw new Error('Notes excerpt is too large.');
  const compressed = await streamBytes(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
    notesLimits.raw + 1024,
  );
  return {
    payload: JSON.stringify({ encoding, shiur }),
    text: Buffer.from(compressed).toString('base64'),
  };
}

/** Legacy plain-text rows stay readable while an inventory is being refreshed. */
export async function decodeSearchDocument(payload: string, text: string) {
  const stored = JSON.parse(payload);
  if (!Object.hasOwn(stored, 'encoding'))
    return { shiur: stored as Shiur, text };
  if (stored.encoding !== encoding || !stored.shiur?.id)
    throw new Error('Unsupported notes excerpt encoding.');
  if (text.length > Math.ceil((notesLimits.raw + 1024) / 3) * 4)
    throw new Error('Notes excerpt is too large.');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text)
    throw new Error('Invalid notes excerpt encoding.');
  const decoded = await streamBytes(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    notesLimits.raw,
  );
  return {
    shiur: stored.shiur as Shiur,
    text: new TextDecoder('utf-8', { fatal: true }).decode(decoded),
  };
}
