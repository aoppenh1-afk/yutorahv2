import { refMetadata, sefariaUrl, type SefariaFetch } from './sefaria';
import type { TranscriptSource } from './sources';

/** A user can correct a reference; it still must resolve to a numbered, canonical Sefaria location. */
export async function verifyManualSource(
  ref: string,
  fetcher: SefariaFetch = fetch,
): Promise<TranscriptSource | null> {
  if (
    ref.length > 250 ||
    !ref.trim() ||
    /[<>]/u.test(ref) ||
    Array.from(ref).some((char) => char.codePointAt(0)! < 32)
  )
    return null;
  const metadata = await refMetadata(ref.trim(), fetcher);
  const url = metadata && sefariaUrl(metadata.url_ref);
  if (!metadata || !url || !metadata.start_indexes.length) return null;
  return {
    ref: metadata.normalized,
    heRef: metadata.hebrew,
    url,
    category: 'Added by you',
    occurrences: [
      {
        offset: 0,
        startMs: 0,
        endMs: 0,
        mention: ref.trim(),
        spans: [],
        origin: 'manual',
        method: 'citation',
        verification: 'Reference checked by Sefaria; selected by you',
      },
    ],
  };
}
